import type { ChatMessage, ChatUser, HistoryCursor, ServerEvent } from '../../backend/src/protocol';

export type ConnectionStatus =
  'authenticating' | 'connecting' | 'syncing' | 'connected' | 'reconnecting' | 'auth-error';
export type PendingMessage = {
  clientId: string;
  text: string;
  createdAt: string;
  status: 'sending' | 'failed';
  error?: string;
};
export type ChatState = {
  status: ConnectionStatus;
  user: ChatUser | null;
  messages: ChatMessage[];
  pending: PendingMessage[];
  nextCursor: HistoryCursor | null;
  historyRequestId: string | null;
  error: string | null;
};

export const initialChatState: ChatState = {
  status: 'authenticating',
  user: null,
  messages: [],
  pending: [],
  nextCursor: null,
  historyRequestId: null,
  error: null,
};

export type ChatAction =
  | { type: 'status'; status: ConnectionStatus; error?: string }
  | { type: 'server'; event: ServerEvent }
  | { type: 'pending'; message: PendingMessage }
  | { type: 'failed'; clientId: string; error: string }
  | { type: 'history-start'; requestId: string }
  | { type: 'error'; error: string | null };

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function confirmMessages(state: ChatState, incoming: ChatMessage[]): ChatState {
  const confirmed = new Set(
    incoming
      .filter((message) => message.uid === state.user?.uid)
      .map((message) => message.clientId),
  );
  return {
    ...state,
    messages: mergeMessages(state.messages, incoming),
    pending: state.pending.filter((message) => !confirmed.has(message.clientId)),
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'status':
      return {
        ...state,
        status: action.status,
        error: action.error ?? null,
        historyRequestId: null,
      };
    case 'pending':
      return {
        ...state,
        error: null,
        pending: [
          ...state.pending.filter((message) => message.clientId !== action.message.clientId),
          action.message,
        ],
      };
    case 'failed':
      return {
        ...state,
        pending: state.pending.map((message) =>
          message.clientId === action.clientId
            ? { ...message, status: 'failed', error: action.error }
            : message,
        ),
      };
    case 'history-start':
      return { ...state, historyRequestId: action.requestId, error: null };
    case 'error':
      return { ...state, error: action.error };
    case 'server': {
      const event = action.event;
      switch (event.type) {
        case 'session:ready':
          return { ...state, user: event.user, status: 'syncing' };
        case 'message:new':
        case 'message:ack':
          return confirmMessages(state, [event.message]);
        case 'history:page': {
          if (event.requestId !== 'initial' && event.requestId !== state.historyRequestId)
            return state;
          const confirmed = confirmMessages(state, event.messages);
          return {
            ...confirmed,
            nextCursor: event.nextCursor,
            historyRequestId: null,
            status: event.requestId === 'initial' ? 'connected' : state.status,
            error: null,
          };
        }
        case 'error': {
          const next = event.clientId
            ? chatReducer(state, { type: 'failed', clientId: event.clientId, error: event.message })
            : { ...state, error: event.message };
          return {
            ...next,
            historyRequestId:
              event.requestId === state.historyRequestId ? null : state.historyRequestId,
          };
        }
      }
    }
  }
}
