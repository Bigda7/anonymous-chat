import { missingFirebaseKeys } from './firebase';
import { useChat } from './use-chat';
import { ChatRoom, RoomMark } from './ChatRoom';

export function App() {
  if (missingFirebaseKeys.length) {
    return (
      <main className="setup-screen">
        <div className="setup-card">
          <div className="brand-mark">
            <RoomMark />
          </div>
          <p className="eyebrow">ANONYMOUS CHAT</p>
          <h1>Connect your room.</h1>
          <p>
            Copy <code>frontend/.env.example</code> to <code>frontend/.env</code>, add your Firebase
            web app configuration, then restart Vite.
          </p>
          <p className="setup-label">Missing configuration</p>
          <ul>
            {missingFirebaseKeys.map((key) => (
              <li key={key}>
                <code>{key}</code>
              </li>
            ))}
          </ul>
          <p>Follow the Firebase setup steps in the project README.</p>
        </div>
      </main>
    );
  }
  return <ConnectedChatRoom />;
}

function ConnectedChatRoom() {
  const chat = useChat();
  return <ChatRoom {...chat} />;
}
