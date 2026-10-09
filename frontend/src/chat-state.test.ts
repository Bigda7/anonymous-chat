import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState, type ChatState } from './chat-state';
import type { ChatMessage } from '../../backend/src/protocol';

const user = { uid: 'alice', displayName: 'Guest ABC123' };
const clientId = '3b9d411c-556f-4f73-9b48-444b517a10c4';
const message: ChatMessage = {
  ...user,
  id: 'persisted-message',
  clientId,
  text: 'Hello',
  createdAt: '2026-10-09T10:00:00.000Z',
};
const connected: ChatState = { ...initialChatState, user, status: 'connected' };

describe('chat state synchronization', () => {
  it('merges a live event received before initial history without duplicates', () => {
    let state = chatReducer(connected, { type: 'server', event: { type: 'message:new', message } });
    state = chatReducer(state, {
      type: 'server',
      event: { type: 'history:page', requestId: 'initial', messages: [message], nextCursor: null },
    });
    state = chatReducer(state, { type: 'server', event: { type: 'message:ack', message } });
    expect(state.messages).toEqual([message]);
    expect(state.status).toBe('connected');
  });

  it('confirms pending sends only for the current user', () => {
    const pending = chatReducer(connected, {
      type: 'pending',
      message: { clientId, text: 'Hello', createdAt: message.createdAt, status: 'sending' },
    });
    const other = chatReducer(pending, {
      type: 'server',
      event: { type: 'message:new', message: { ...message, id: 'other', uid: 'bob' } },
    });
    expect(other.pending).toHaveLength(1);
    expect(
      chatReducer(other, { type: 'server', event: { type: 'message:ack', message } }).pending,
    ).toEqual([]);
  });

  it('keeps unconfirmed text on disconnect and resolves it from reconnect history', () => {
    let state = chatReducer(connected, {
      type: 'pending',
      message: { clientId, text: 'Hello', createdAt: message.createdAt, status: 'sending' },
    });
    state = chatReducer(state, { type: 'status', status: 'reconnecting' });
    expect(state.pending[0]?.text).toBe('Hello');
    state = chatReducer(state, {
      type: 'server',
      event: { type: 'history:page', requestId: 'initial', messages: [message], nextCursor: null },
    });
    expect(state.pending).toEqual([]);
    expect(state.messages).toHaveLength(1);
  });

  it('prepends older history and ignores stale pagination responses', () => {
    const older = { ...message, id: 'older', createdAt: '2026-10-08T10:00:00.000Z' };
    let state = { ...connected, messages: [message], historyRequestId: 'active-request' };
    const stale = chatReducer(state, {
      type: 'server',
      event: { type: 'history:page', requestId: 'stale', messages: [older], nextCursor: null },
    });
    expect(stale).toBe(state);
    state = {
      ...chatReducer(state, {
        type: 'server',
        event: {
          type: 'history:page',
          requestId: 'active-request',
          messages: [older],
          nextCursor: null,
        },
      }),
      historyRequestId: 'another-request',
    };
    expect(state.messages.map((entry) => entry.id)).toEqual(['older', 'persisted-message']);
  });

  it('marks failed sends without losing their retry ID or text', () => {
    let state = chatReducer(connected, {
      type: 'pending',
      message: { clientId, text: 'Hello', createdAt: message.createdAt, status: 'sending' },
    });
    state = chatReducer(state, {
      type: 'server',
      event: { type: 'error', code: 'STORAGE_UNAVAILABLE', message: 'Try again', clientId },
    });
    expect(state.pending[0]).toMatchObject({
      clientId,
      text: 'Hello',
      status: 'failed',
      error: 'Try again',
    });
  });
});
