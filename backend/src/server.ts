import { createServer } from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { clientEventSchema, type ChatUser, type ServerEvent } from './protocol.js';
import { RateLimiter } from './rate-limit.js';
import { MessageConflictError } from './domain.js';
import type { ChatStore } from './store.js';

export type VerifiedIdentity = { uid: string; expiresAt: number };

type ServerOptions = {
  store: ChatStore;
  verifyToken: (token: string) => Promise<VerifiedIdentity>;
  origins: string[];
  authTimeoutMs?: number;
  reportError?: (error: unknown) => void;
};

async function withTimeout<T>(operation: Promise<T>, timeoutMs = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Operation timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createChatServer(options: ServerOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => {
    response.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
  const sessions = new Map<WebSocket, ChatUser>();
  const sendLimiter = new RateLimiter(10, 10000);
  const historyLimiter = new RateLimiter(10, 10000);
  const connectionLimiter = new RateLimiter(30, 60000);
  const reportError =
    options.reportError ??
    ((error: unknown) => {
      console.error('Chat operation failed:', error instanceof Error ? error.name : 'UnknownError');
    });

  function send(socket: WebSocket, event: ServerEvent) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, 'Client is too slow.');
      return;
    }
    socket.send(JSON.stringify(event));
  }

  function broadcast(event: ServerEvent) {
    for (const socket of sessions.keys()) send(socket, event);
  }

  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== '/ws' || !origin || !options.origins.includes(origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (
      wss.clients.size >= 200 ||
      !connectionLimiter.allow(request.socket.remoteAddress ?? 'unknown')
    ) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (socket) => {
    alive.set(socket, true);
    let queue = Promise.resolve();
    let queuedCount = 0;
    let authenticationStarted = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const authTimer = setTimeout(() => {
      send(socket, { type: 'error', code: 'AUTH_REQUIRED', message: 'Authentication timed out.' });
      socket.close(4001, 'Authentication timed out.');
    }, options.authTimeoutMs ?? 10000);

    socket.on('pong', () => alive.set(socket, true));
    socket.on('error', reportError);
    socket.on('close', () => {
      sessions.delete(socket);
      clearTimeout(authTimer);
      clearTimeout(expiryTimer);
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Only JSON text events are supported.');
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: 'error', code: 'INVALID_EVENT', message: 'Send a valid JSON event.' });
        return;
      }
      const parsed = clientEventSchema.safeParse(decoded);
      if (!parsed.success) {
        send(socket, {
          type: 'error',
          code: 'INVALID_EVENT',
          message: 'The event payload is invalid.',
        });
        return;
      }
      if (queuedCount >= 8) {
        send(socket, { type: 'error', code: 'SERVER_BUSY', message: 'Too many queued events.' });
        socket.close(1013, 'Too many queued events.');
        return;
      }
      const event = parsed.data;
      queuedCount += 1;
      queue = queue
        .then(async () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (event.type === 'auth') {
            if (authenticationStarted) {
              send(socket, {
                type: 'error',
                code: 'INVALID_EVENT',
                message: 'This connection is already authenticating.',
              });
              return;
            }
            authenticationStarted = true;
            let identity: VerifiedIdentity;
            try {
              identity = await withTimeout(options.verifyToken(event.token));
              if (identity.expiresAt <= Date.now()) throw new Error('Expired token.');
            } catch {
              send(socket, {
                type: 'error',
                code: 'AUTH_FAILED',
                message: 'Your session could not be verified. Reconnecting.',
              });
              socket.close(4001, 'Invalid session.');
              return;
            }
            try {
              const user = await withTimeout(options.store.upsertUser(identity.uid));
              if (socket.readyState !== WebSocket.OPEN) return;
              clearTimeout(authTimer);
              expiryTimer = setTimeout(
                () => socket.close(4001, 'Session expired.'),
                Math.min(identity.expiresAt - Date.now(), 2147483647),
              );
              sessions.set(socket, user);
              send(socket, { type: 'session:ready', user });
              const page = await withTimeout(options.store.getHistory());
              send(socket, { type: 'history:page', requestId: 'initial', ...page });
            } catch (error) {
              reportError(error);
              send(socket, {
                type: 'error',
                code: 'STORAGE_UNAVAILABLE',
                message: 'The chat history is unavailable. Reconnecting.',
              });
              socket.close(1013, 'Storage unavailable.');
            }
            return;
          }

          const user = sessions.get(socket);
          if (!user) {
            send(socket, {
              type: 'error',
              code: 'AUTH_REQUIRED',
              message: 'Authenticate before using the chat.',
            });
            return;
          }
          if (event.type === 'history:request') {
            if (!historyLimiter.allow(user.uid)) {
              send(socket, {
                type: 'error',
                code: 'RATE_LIMITED',
                requestId: event.requestId,
                message: 'Please wait before loading more history.',
              });
              return;
            }
            try {
              const page = await withTimeout(options.store.getHistory(event.before));
              send(socket, { type: 'history:page', requestId: event.requestId, ...page });
            } catch (error) {
              reportError(error);
              send(socket, {
                type: 'error',
                code: 'STORAGE_UNAVAILABLE',
                requestId: event.requestId,
                message: 'Could not load older messages. Try again.',
              });
            }
            return;
          }

          if (!sendLimiter.allow(user.uid)) {
            send(socket, {
              type: 'error',
              code: 'RATE_LIMITED',
              clientId: event.clientId,
              message: 'You are sending too quickly. Wait a few seconds and retry.',
            });
            return;
          }
          try {
            const { message, created } = await withTimeout(
              options.store.saveMessage(user, event.clientId, event.text),
            );
            if (created) broadcast({ type: 'message:new', message });
            send(socket, { type: 'message:ack', message });
          } catch (error) {
            reportError(error);
            send(socket, {
              type: 'error',
              clientId: event.clientId,
              code: error instanceof MessageConflictError ? 'ID_CONFLICT' : 'STORAGE_UNAVAILABLE',
              message:
                error instanceof MessageConflictError
                  ? 'This message ID is already in use.'
                  : 'Could not save your message. Retry when connected.',
            });
          }
        })
        .catch((error: unknown) => {
          reportError(error);
          socket.close(1011, 'Unexpected server error.');
        })
        .finally(() => {
          queuedCount -= 1;
        });
    });
  });

  const heartbeat = setInterval(() => {
    sendLimiter.prune();
    historyLimiter.prune();
    connectionLimiter.prune();
    for (const socket of wss.clients) {
      if (!alive.get(socket)) {
        socket.terminate();
      } else {
        alive.set(socket, false);
        socket.ping();
      }
    }
  }, 30000);
  heartbeat.unref();

  async function close() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }

  return { app, server, close };
}
