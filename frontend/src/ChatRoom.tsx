import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { MAX_MESSAGE_LENGTH } from '../../backend/src/protocol';
import type { ChatState, ConnectionStatus } from './chat-state';

const statusLabels: Record<ConnectionStatus, string> = {
  authenticating: 'Joining the room',
  connecting: 'Connecting',
  syncing: 'Loading conversation',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  'auth-error': 'Unable to join',
};

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m5 12 14-7-4 14-3-6-7-1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="m12 13 7-8" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function RoomMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M6 7h20v14H15l-7 5v-5H6V7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M11 13h10M11 17h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

type ChatRoomProps = {
  state: ChatState;
  sendMessage: (text: string) => boolean;
  retryMessage: (clientId: string) => void;
  loadOlder: () => void;
  dismissError: () => void;
};

export function ChatRoom({
  state,
  sendMessage,
  retryMessage,
  loadOlder,
  dismissError,
}: ChatRoomProps) {
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const historyAnchor = useRef<{ height: number; top: number } | null>(null);
  const previousLastId = useRef<string | undefined>(undefined);
  const composition = useRef(false);
  const connected = state.status === 'connected';
  const canSend = connected && state.pending.length < 8;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (historyAnchor.current && !state.historyRequestId) {
      element.scrollTop =
        historyAnchor.current.top + element.scrollHeight - historyAnchor.current.height;
      historyAnchor.current = null;
      return;
    }
    const lastId = state.pending.at(-1)?.clientId ?? state.messages.at(-1)?.id;
    if (nearBottom.current) {
      element.scrollTop = element.scrollHeight;
      setUnread(false);
    } else if (lastId && lastId !== previousLastId.current) {
      setUnread(true);
    }
    previousLastId.current = lastId;
  }, [state.messages, state.pending, state.historyRequestId]);

  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 140)}px`;
  }, [draft]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (sendMessage(draft)) {
      setDraft('');
      nearBottom.current = true;
      textarea.current?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !composition.current
    ) {
      event.preventDefault();
      submit();
    }
  }

  function older() {
    if (viewport.current)
      historyAnchor.current = {
        height: viewport.current.scrollHeight,
        top: viewport.current.scrollTop,
      };
    loadOlder();
  }

  function jumpToLatest() {
    nearBottom.current = true;
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: 'smooth' });
    setUnread(false);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Common Room home">
          <span className="brand-mark">
            <RoomMark />
          </span>
          <span>
            common<span className="brand-light">room</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="eyebrow">YOUR SPACE</span>
          <span className="small-tag">PUBLIC</span>
        </div>
        <div className="room-link">
          <span className="hash">#</span>
          <span>general</span>
          <span className="room-active-dot" />
        </div>
        <div className="room-description">
          <h2>
            A little space
            <br />
            for everyone.
          </h2>
          <p>
            Drop a thought. Share a moment.
            <br />
            See where the conversation goes.
          </p>
          <div className="room-art" aria-hidden="true">
            <div className="art-bubble art-bubble-one">
              <span />
              <span />
              <span />
            </div>
            <div className="art-bubble art-bubble-two">
              <span />
              <span />
            </div>
          </div>
        </div>
        <div className="sidebar-note">
          <span className="note-line" />
          <p>
            One room. Every voice.
            <br />
            No account setup needed.
          </p>
        </div>
        <div className="identity">
          <div className="avatar self-avatar">{state.user?.displayName.slice(-2) ?? 'G'}</div>
          <div>
            <strong>{state.user?.displayName ?? 'Anonymous guest'}</strong>
            <span>Your anonymous identity</span>
          </div>
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div>
            <div className="room-title">
              <span className="hash">#</span>
              <h1>general</h1>
              <span className="header-tag">OPEN TO ALL</span>
            </div>
            <p>A shared conversation, a fresh perspective.</p>
          </div>
          <div className={`connection-status ${connected ? 'is-connected' : ''}`} role="status">
            <span />
            {statusLabels[state.status]}
          </div>
        </header>
        <div className="chat-notice">
          <span className="notice-symbol" aria-hidden="true">
            i
          </span>
          <p>You're here anonymously. Everyone in this room can see your messages.</p>
        </div>
        {state.error && (
          <div className="error-banner" role="alert">
            <span>{state.error}</span>
            {state.status === 'auth-error' ? (
              <button onClick={() => window.location.reload()}>Try again</button>
            ) : (
              <button onClick={dismissError} aria-label="Dismiss error">
                Dismiss
              </button>
            )}
          </div>
        )}

        <div className="conversation-wrapper">
          <div
            className="conversation"
            ref={viewport}
            role="region"
            aria-label="Chat messages"
            tabIndex={0}
            onScroll={() => {
              const element = viewport.current;
              if (!element) return;
              nearBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 90;
              if (nearBottom.current) setUnread(false);
            }}
          >
            <div className="conversation-intro">
              <div className="intro-mark">
                <RoomMark />
              </div>
              <p className="eyebrow">THE CONVERSATION STARTS HERE</p>
              <h2>Welcome to the common room.</h2>
              <p>Different people. One place to connect.</p>
            </div>
            {state.nextCursor && (
              <div className="history-control">
                <button
                  className="text-button"
                  onClick={older}
                  disabled={!connected || Boolean(state.historyRequestId)}
                >
                  {state.historyRequestId ? 'Loading earlier messages...' : 'Load earlier messages'}
                </button>
              </div>
            )}
            {state.messages.length === 0 && (
              <div className="empty-state">
                {connected
                  ? 'It is quiet here. Be the first to say hello.'
                  : state.status === 'auth-error'
                    ? 'The room is waiting for you.'
                    : 'Getting the conversation ready...'}
              </div>
            )}

            <ol className="message-list">
              {state.messages.map((message, index) => {
                const previous = state.messages[index - 1];
                const own = message.uid === state.user?.uid;
                const day = new Date(message.createdAt).toDateString();
                const showDay = !previous || new Date(previous.createdAt).toDateString() !== day;
                return (
                  <li key={message.id}>
                    {showDay && (
                      <div className="date-divider">
                        <span>{dateFormatter.format(new Date(message.createdAt))}</span>
                      </div>
                    )}
                    <article className={`message ${own ? 'own-message' : ''}`}>
                      <div className={`avatar ${own ? 'self-avatar' : ''}`}>
                        {message.displayName.slice(-2)}
                      </div>
                      <div className="message-content">
                        <div className="message-meta">
                          <strong>{message.displayName}</strong>
                          {own && <span className="you-label">you</span>}
                          <time dateTime={message.createdAt}>
                            {timeFormatter.format(new Date(message.createdAt))}
                          </time>
                        </div>
                        <p>{message.text}</p>
                      </div>
                    </article>
                  </li>
                );
              })}
              {state.pending.map((message) => (
                <li key={message.clientId}>
                  <article className="message own-message pending-message">
                    <div className="avatar self-avatar">{state.user?.displayName.slice(-2)}</div>
                    <div className="message-content">
                      <div className="message-meta">
                        <strong>{state.user?.displayName}</strong>
                        <span className="you-label">you</span>
                        <span className="delivery-status" role="status">
                          {message.status === 'failed'
                            ? 'Not confirmed'
                            : connected
                              ? 'Sending...'
                              : 'Waiting for connection...'}
                        </span>
                      </div>
                      <p>{message.text}</p>
                      {message.status === 'failed' && (
                        <div className="delivery-error">
                          <span>{message.error}</span>
                          <button
                            className="text-button"
                            disabled={!connected}
                            onClick={() => retryMessage(message.clientId)}
                          >
                            Retry
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                </li>
              ))}
            </ol>
          </div>
          {unread && (
            <button className="latest-button" onClick={jumpToLatest}>
              New messages below
            </button>
          )}
        </div>

        <footer className="composer-area">
          <form className="composer" onSubmit={submit}>
            <label className="sr-only" htmlFor="message">
              Your message
            </label>
            <textarea
              id="message"
              ref={textarea}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onCompositionStart={() => {
                composition.current = true;
              }}
              onCompositionEnd={() => {
                composition.current = false;
              }}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder={
                connected ? 'Message #general' : 'Your message can wait here while we connect...'
              }
              rows={1}
              aria-describedby="composer-help"
            />
            <button
              className="send-button"
              type="submit"
              disabled={!canSend || !draft.trim()}
              aria-label="Send message"
            >
              <SendIcon />
            </button>
          </form>
          <div className="composer-help" id="composer-help">
            <span>
              <kbd>Enter</kbd> to send <span className="help-separator">/</span>{' '}
              <kbd>Shift + Enter</kbd> for a new line
            </span>
            <span className={draft.length > 1800 ? 'near-limit' : ''}>
              {draft.length} / {MAX_MESSAGE_LENGTH}
            </span>
          </div>
        </footer>
      </main>
    </div>
  );
}
