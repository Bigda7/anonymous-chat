import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  MAX_MESSAGE_LENGTH,
  serverEventSchema,
  type ClientEvent,
} from '../../backend/src/protocol';
import { ensureAnonymousUser, webSocketUrl } from './firebase';
import { chatReducer, initialChatState, type ChatAction, type PendingMessage } from './chat-state';

function authErrorMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'auth/operation-not-allowed')
    return 'Anonymous sign-in is disabled. Enable it in Firebase Authentication.';
  if (code === 'auth/too-many-requests')
    return 'Firebase has temporarily limited sign-in. Please try again later.';
  if (code === 'auth/network-request-failed')
    return 'Could not reach Firebase. Check your connection and try again.';
  return 'Could not join the room. Check the Firebase configuration and try again.';
}

export function useChat() {
  const [state, setState] = useState(initialChatState);
  const stateRef = useRef(state);
  const socketRef = useRef<WebSocket | null>(null);
  const deliveryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const historyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dispatch = useCallback((action: ChatAction) => {
    stateRef.current = chatReducer(stateRef.current, action);
    setState(stateRef.current);
  }, []);

  const sendEvent = useCallback((event: ClientEvent) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }, []);

  const transmit = useCallback(
    (message: PendingMessage) => {
      clearTimeout(deliveryTimers.current.get(message.clientId));
      if (!sendEvent({ type: 'message:send', clientId: message.clientId, text: message.text })) {
        dispatch({
          type: 'failed',
          clientId: message.clientId,
          error: 'Connection interrupted. Retry when connected.',
        });
        return;
      }
      deliveryTimers.current.set(
        message.clientId,
        setTimeout(() => {
          deliveryTimers.current.delete(message.clientId);
          dispatch({
            type: 'failed',
            clientId: message.clientId,
            error: 'Delivery was not confirmed. You can safely retry.',
          });
        }, 20000),
      );
    },
    [dispatch, sendEvent],
  );

  useEffect(() => {
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let identity: User;
    let url: string;
    let activeSocket: WebSocket | undefined;
    const timers = deliveryTimers.current;

    function clearTimers() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      clearTimeout(historyTimer.current);
    }

    async function connect(forceRefresh = false) {
      if (stopped) return;
      dispatch({ type: 'status', status: attempts === 0 ? 'connecting' : 'reconnecting' });
      try {
        const token = await identity.getIdToken(forceRefresh);
        if (stopped) return;
        const socket = new WebSocket(url);
        activeSocket = socket;
        socketRef.current = socket;
        socket.onopen = () => {
          if (!stopped) sendEvent({ type: 'auth', token });
        };
        socket.onmessage = (messageEvent) => {
          if (stopped || socket !== socketRef.current) return;
          let payload: unknown;
          try {
            payload = JSON.parse(String(messageEvent.data));
          } catch {
            socket.close(1002, 'Invalid server event.');
            return;
          }
          const parsed = serverEventSchema.safeParse(payload);
          if (!parsed.success) {
            dispatch({ type: 'error', error: 'The server sent an invalid response.' });
            socket.close(1002, 'Invalid server event.');
            return;
          }
          const event = parsed.data;
          if (
            (event.type === 'message:ack' || event.type === 'message:new') &&
            event.message.uid === stateRef.current.user?.uid
          ) {
            clearTimeout(timers.get(event.message.clientId));
            timers.delete(event.message.clientId);
          }
          if (event.type === 'error' && event.clientId) {
            clearTimeout(timers.get(event.clientId));
            timers.delete(event.clientId);
          }
          if (event.type === 'history:page' || (event.type === 'error' && event.requestId)) {
            clearTimeout(historyTimer.current);
          }
          dispatch({ type: 'server', event });
          if (event.type === 'history:page' && event.requestId === 'initial') {
            attempts = 0;
            for (const pending of stateRef.current.pending) {
              if (pending.status === 'sending') transmit(pending);
            }
          }
        };
        socket.onclose = (event) => {
          if (stopped || socket !== socketRef.current) return;
          socketRef.current = null;
          clearTimers();
          scheduleReconnect(event.code === 4001);
        };
        socket.onerror = () => socket.close();
      } catch {
        if (!stopped) scheduleReconnect(true);
      }
    }

    function scheduleReconnect(forceRefresh: boolean) {
      attempts += 1;
      dispatch({
        type: 'status',
        status: 'reconnecting',
        error: 'Connection lost. Trying to reconnect automatically.',
      });
      const delay = Math.min(1000 * 2 ** Math.min(attempts - 1, 4), 15000) + Math.random() * 300;
      retryTimer = setTimeout(() => {
        void connect(forceRefresh);
      }, delay);
    }

    void (async () => {
      try {
        url = webSocketUrl();
        identity = await ensureAnonymousUser();
        if (!stopped) void connect();
      } catch (error) {
        if (!stopped)
          dispatch({ type: 'status', status: 'auth-error', error: authErrorMessage(error) });
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimers();
      if (activeSocket) {
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onerror = null;
        activeSocket.onclose = null;
        activeSocket.close();
      }
      socketRef.current = null;
    };
  }, [dispatch, sendEvent, transmit]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (
        stateRef.current.status !== 'connected' ||
        !trimmed ||
        trimmed.length > MAX_MESSAGE_LENGTH ||
        stateRef.current.pending.length >= 8
      )
        return false;
      const message: PendingMessage = {
        clientId: crypto.randomUUID(),
        text: trimmed,
        createdAt: new Date().toISOString(),
        status: 'sending',
      };
      dispatch({ type: 'pending', message });
      transmit(message);
      return true;
    },
    [dispatch, transmit],
  );

  const retryMessage = useCallback(
    (clientId: string) => {
      if (stateRef.current.status !== 'connected') return;
      const pending = stateRef.current.pending.find((message) => message.clientId === clientId);
      if (!pending) return;
      const message: PendingMessage = { ...pending, status: 'sending', error: undefined };
      dispatch({ type: 'pending', message });
      transmit(message);
    },
    [dispatch, transmit],
  );

  const loadOlder = useCallback(() => {
    const current = stateRef.current;
    if (!current.nextCursor || current.historyRequestId || current.status !== 'connected') return;
    const requestId = crypto.randomUUID();
    dispatch({ type: 'history-start', requestId });
    if (!sendEvent({ type: 'history:request', requestId, before: current.nextCursor })) {
      dispatch({
        type: 'server',
        event: {
          type: 'error',
          code: 'STORAGE_UNAVAILABLE',
          requestId,
          message: 'Connection interrupted. Try again.',
        },
      });
      return;
    }
    historyTimer.current = setTimeout(() => {
      dispatch({
        type: 'server',
        event: {
          type: 'error',
          code: 'STORAGE_UNAVAILABLE',
          requestId,
          message: 'Loading history timed out. Try again.',
        },
      });
    }, 20000);
  }, [dispatch, sendEvent]);

  return {
    state,
    sendMessage,
    retryMessage,
    loadOlder,
    dismissError: () => dispatch({ type: 'error', error: null }),
  };
}
