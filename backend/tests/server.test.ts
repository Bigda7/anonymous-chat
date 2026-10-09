import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createChatServer } from '../src/server.js';
import { guestName, MessageConflictError, messageDocumentId } from '../src/domain.js';
import type { ChatStore } from '../src/store.js';
import {
  serverEventSchema,
  type ChatMessage,
  type HistoryCursor,
  type ServerEvent,
} from '../src/protocol.js';

class MemoryStore implements ChatStore {
  readonly users = new Map<string, { uid: string; displayName: string }>();
  readonly messages = new Map<string, ChatMessage>();
  failWrites = false;

  async upsertUser(uid: string) {
    const user = { uid, displayName: guestName(uid) };
    this.users.set(uid, user);
    return user;
  }

  async getHistory(_before?: HistoryCursor) {
    return { messages: [...this.messages.values()], nextCursor: null };
  }

  async saveMessage(user: { uid: string; displayName: string }, clientId: string, text: string) {
    if (this.failWrites) throw new Error('Unavailable store.');
    const id = messageDocumentId(user.uid, clientId);
    const existing = this.messages.get(id);
    if (existing) {
      if (existing.text !== text) throw new MessageConflictError('Conflicting ID.');
      return { message: existing, created: false };
    }
    const message = { ...user, id, clientId, text, createdAt: new Date().toISOString() };
    this.messages.set(id, message);
    return { message, created: true };
  }
}

class Client {
  private readonly received: ServerEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: ServerEvent) => boolean;
    resolve: (event: ServerEvent) => void;
  }> = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const event = serverEventSchema.parse(JSON.parse(raw.toString()));
      const index = this.waiters.findIndex((waiter) => waiter.predicate(event));
      const waiter = this.waiters[index];
      if (waiter) {
        this.waiters.splice(index, 1);
        waiter.resolve(event);
      } else {
        this.received.push(event);
      }
    });
  }

  send(event: unknown) {
    this.socket.send(JSON.stringify(event));
  }

  next(predicate: (event: ServerEvent) => boolean) {
    const index = this.received.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.received.splice(index, 1)[0]!);
    return new Promise<ServerEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Expected WebSocket event was not received.')),
        2500,
      );
      this.waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  async authenticate(token: string) {
    this.send({ type: 'auth', token });
    await this.next((event) => event.type === 'session:ready');
    return this.next((event) => event.type === 'history:page');
  }
}

describe('authenticated chat over actual WebSocket connections', () => {
  let chat: ReturnType<typeof createChatServer>;
  let store: MemoryStore;
  let url: string;
  let httpUrl: string;
  const clients: Client[] = [];
  const origin = 'http://localhost:5173';

  beforeEach(async () => {
    store = new MemoryStore();
    chat = createChatServer({
      store,
      origins: [origin],
      reportError: vi.fn(),
      async verifyToken(token) {
        if (!token.startsWith('valid:')) throw new Error('Invalid token.');
        return { uid: token.slice(6), expiresAt: Date.now() + 60000 };
      },
    });
    await new Promise<void>((resolve) => chat.server.listen(0, '127.0.0.1', resolve));
    const port = (chat.server.address() as AddressInfo).port;
    url = `ws://127.0.0.1:${port}/ws`;
    httpUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.terminate();
    await chat.close();
  });

  async function connect() {
    const socket = new WebSocket(url, { origin });
    const client = new Client(socket);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return client;
  }

  it('exposes a liveness endpoint', async () => {
    const response = await fetch(`${httpUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('rejects origins that are not explicitly allowed', async () => {
    const socket = new WebSocket(url, { origin: 'https://untrusted.example' });
    const status = await new Promise<number>((resolve) => {
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
        socket.terminate();
      });
      socket.on('error', () => {});
    });
    expect(status).toBe(403);
  });

  it('does not allow unauthenticated writes', async () => {
    const client = await connect();
    client.send({ type: 'message:send', clientId: randomUUID(), text: 'Hello' });
    expect(await client.next((event) => event.type === 'error')).toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(store.messages.size).toBe(0);
  });

  it('rejects a forged token and closes the connection', async () => {
    const client = await connect();
    const closed = new Promise<number>((resolve) => client.socket.once('close', resolve));
    client.send({ type: 'auth', token: 'forged' });
    expect(await client.next((event) => event.type === 'error')).toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(await closed).toBe(4001);
    expect(store.users.size).toBe(0);
  });

  it('persists users and broadcasts a stored message to all authenticated clients', async () => {
    const first = await connect();
    const second = await connect();
    const unauthenticated = await connect();
    await first.authenticate('valid:alice');
    await second.authenticate('valid:bob');
    first.send({ type: 'message:send', clientId: randomUUID(), text: '  Hello everyone  ' });
    const event = await second.next((message) => message.type === 'message:new');
    expect(event).toMatchObject({ message: { uid: 'alice', text: 'Hello everyone' } });
    expect(store.users.size).toBe(2);
    expect(store.messages.size).toBe(1);
    expect(await first.next((message) => message.type === 'message:ack')).toMatchObject({
      message: { text: 'Hello everyone' },
    });
    expect(unauthenticated.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('restores history on reconnect and acknowledges retries without duplicate records', async () => {
    const first = await connect();
    await first.authenticate('valid:alice');
    const clientId = randomUUID();
    first.send({ type: 'message:send', clientId, text: 'Keep this message' });
    await first.next((event) => event.type === 'message:ack');
    first.socket.terminate();
    const reconnect = await connect();
    const history = await reconnect.authenticate('valid:alice');
    expect(history).toMatchObject({ messages: [{ text: 'Keep this message' }] });
    reconnect.send({ type: 'message:send', clientId, text: 'Keep this message' });
    expect(await reconnect.next((event) => event.type === 'message:ack')).toMatchObject({
      message: { clientId },
    });
    expect(store.messages.size).toBe(1);
    expect(store.users.size).toBe(1);
  });

  it('rejects changing text under an already persisted client ID', async () => {
    const client = await connect();
    await client.authenticate('valid:alice');
    const clientId = randomUUID();
    client.send({ type: 'message:send', clientId, text: 'Original' });
    await client.next((event) => event.type === 'message:ack');
    client.send({ type: 'message:send', clientId, text: 'Changed' });
    expect(await client.next((event) => event.type === 'error')).toMatchObject({
      code: 'ID_CONFLICT',
      clientId,
    });
    expect([...store.messages.values()][0]?.text).toBe('Original');
  });

  it('never confirms a message when storage fails', async () => {
    const client = await connect();
    await client.authenticate('valid:alice');
    store.failWrites = true;
    const clientId = randomUUID();
    client.send({ type: 'message:send', clientId, text: 'Not persisted' });
    expect(await client.next((event) => event.type === 'error')).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      clientId,
    });
    expect(store.messages.size).toBe(0);
  });

  it('validates empty, oversized and spoofed message payloads', async () => {
    const client = await connect();
    await client.authenticate('valid:alice');
    for (const payload of [
      { text: '   ' },
      { text: 'x'.repeat(2001) },
      { text: 'Spoofed', uid: 'someone-else' },
    ]) {
      client.send({ type: 'message:send', clientId: randomUUID(), ...payload });
      expect(await client.next((event) => event.type === 'error')).toMatchObject({
        code: 'INVALID_EVENT',
      });
    }
    client.socket.send('malformed');
    expect(await client.next((event) => event.type === 'error')).toMatchObject({
      code: 'INVALID_EVENT',
    });
    expect(store.messages.size).toBe(0);
  });

  it('applies the sending limit to a user across multiple sockets', async () => {
    const first = await connect();
    const second = await connect();
    await first.authenticate('valid:alice');
    await second.authenticate('valid:alice');
    for (let index = 0; index < 10; index += 1) {
      first.send({ type: 'message:send', clientId: randomUUID(), text: `Message ${index}` });
      await first.next((event) => event.type === 'message:ack');
    }
    second.send({ type: 'message:send', clientId: randomUUID(), text: 'Over the limit' });
    expect(await second.next((event) => event.type === 'error')).toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(store.messages.size).toBe(10);
  });

  it('passes the exact history cursor to the store and correlates the response', async () => {
    const client = await connect();
    await client.authenticate('valid:alice');
    const getHistory = vi.spyOn(store, 'getHistory');
    const before = { id: 'a'.repeat(64), seconds: 100, nanoseconds: 123456789 };
    const requestId = randomUUID();
    client.send({ type: 'history:request', requestId, before });
    expect(await client.next((event) => event.type === 'history:page')).toMatchObject({
      requestId,
    });
    expect(getHistory).toHaveBeenCalledWith(before);
  });
});
