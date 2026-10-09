# Anonymous Chat

A shared anonymous chat built with React, TypeScript, Vite, Express, WebSockets, and Firebase.

Users join automatically through Firebase Anonymous Authentication. Everyone participates in one public room, and Cloud Firestore stores user profiles and message history.

## Features

- Automatic anonymous sign-in with a persistent browser session.
- One shared room without registration forms, passwords, replies, or threads.
- Real-time message delivery over WebSockets.
- Persistent history with older messages loaded in pages of 50.
- Automatic reconnection with exponential backoff.
- Delivery states and safe retries without duplicate message records.
- Responsive interface with Enter to send and Shift + Enter for a new line.
- Server-side identity verification, input validation, and rate limiting.

## Tech stack

| Application | Technologies |
| --- | --- |
| Frontend | React, TypeScript, Vite, Firebase Authentication, browser WebSocket API |
| Backend | Express, TypeScript, `ws`, Firebase Admin SDK |
| Database | Cloud Firestore |
| Package management | npm workspaces |

## Project structure

```text
frontend/
  src/
    App.tsx               Configuration and chat startup
    ChatRoom.tsx          Chat interface
    firebase.ts           Anonymous authentication
    use-chat.ts           WebSocket lifecycle and delivery
    chat-state.ts         Message and history synchronization
    styles.css            Responsive styles
  .env.example
backend/
  src/
    index.ts              Application startup
    config.ts             Environment validation
    firebase.ts           Firebase Admin initialization
    protocol.ts           Shared types and validation schemas
    domain.ts             Guest names and message identity
    store.ts              Firestore persistence and pagination
    server.ts             Express and WebSocket server
    rate-limit.ts         Per-user limits
  tests/
  firestore.rules
  .env.example
firebase.json
package.json
package-lock.json
```

The frontend imports the browser-safe protocol module from `backend/src/protocol.ts`. Keep both application directories when building the frontend.

## Requirements

- Node.js 22.12 or later.
- npm.
- A Firebase project with Anonymous Authentication and a default Cloud Firestore database.
- Firebase Admin credentials for local backend development.

## Setup

Run commands from the repository root.

```sh
npm ci
```

Create `frontend/.env` from `frontend/.env.example` and `backend/.env` from `backend/.env.example`.

On Windows PowerShell:

```powershell
Copy-Item frontend/.env.example frontend/.env
Copy-Item backend/.env.example backend/.env
```

On macOS or Linux:

```sh
cp frontend/.env.example frontend/.env
cp backend/.env.example backend/.env
```

### Firebase web app

1. Open the [Firebase Console](https://console.firebase.google.com/) and create or select a project.
2. Open **Project settings > General > Your apps** and register a web app using the `</>` button.
3. Copy `apiKey`, `authDomain`, `projectId`, and `appId` from its Firebase configuration into `frontend/.env`.

```dotenv
VITE_FIREBASE_API_KEY=your-web-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_APP_ID=your-web-app-id
VITE_WS_URL=ws://localhost:3001/ws
VITE_USE_FIREBASE_EMULATORS=false
```

Find an existing web app's configuration in **Project settings > Your apps > Firebase SDK snippet > Config**. See the [Firebase configuration guide](https://support.google.com/firebase/answer/7015592).

### Anonymous Authentication

Open **Authentication > Sign-in method**, enable the **Anonymous** provider, and save. See [Firebase Anonymous Authentication](https://firebase.google.com/docs/auth/web/anonymous-auth).

The app restores the existing anonymous session before creating a new user. Tabs in one browser profile usually share the same identity; use separate profiles or a normal and private window to test different users.

### Cloud Firestore

1. Open **Firestore Database > Create database**.
2. Create a Standard edition database in Native mode with the database ID **`(default)`**.
3. Select a suitable region and use **Production mode**.
4. Open **Rules**, paste the contents of `backend/firestore.rules`, and publish them.

The browser uses Firebase only for Authentication. All Firestore operations run through the backend. The supplied rules deny direct client access; Admin SDK access uses IAM, so the backend verifies identities and validates requests itself. See [Firestore Security Rules](https://firebase.google.com/docs/firestore/security/get-started).

The backend creates the `users` and `messages` collections as data is first saved. No manual collection creation is required.

### Firebase Admin credentials

1. Open **Project settings > Service accounts > Firebase Admin SDK**.
2. Generate a private key and download the JSON file.
3. Save it as `backend/secrets/service-account.json`.
4. Configure `backend/.env`:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3001
CLIENT_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173
FIREBASE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=./secrets/service-account.json
```

Use the same project ID in both applications and in the service account. With the npm commands below, relative credential paths are resolved from `backend/`.

The JSON file contains a private key and must remain on the server. Never copy it into the frontend or a `VITE_*` variable. Environment files and `backend/secrets/` are excluded from Git. On supported Google infrastructure, Application Default Credentials can replace the JSON file when the service identity has the appropriate IAM permissions. See [Firebase Admin setup](https://firebase.google.com/docs/admin/setup).

## Development

Start both applications with one command:

```sh
npm run dev
```

| Service | Address |
| --- | --- |
| Frontend | `http://localhost:5173` |
| Backend | `http://localhost:3001` |
| WebSocket | `ws://localhost:3001/ws` |
| HTTP liveness | `http://localhost:3001/health` |

Alternatively, run `npm run dev:frontend` and `npm run dev:backend` in separate terminals from the root.

Restart the corresponding process after editing its `.env`. Press Ctrl+C to stop development servers.

Cloud Firestore runs in Firebase, not as a local process started by `npm run dev`.

## Checks and production builds

```sh
npm run check
npm test
npm run build
```

`check` runs strict TypeScript checks. Backend tests use actual local WebSocket connections with an in-memory store and an injected token verifier. Frontend tests cover message merging, acknowledgments, retries, and history synchronization. These tests do not replace verification against a real Firebase project.

After building, run `npm start` for the backend and `npm run preview` for the frontend in separate terminals. The frontend preview uses `http://localhost:4173`.

## How messages are delivered

1. The browser signs in anonymously and obtains a Firebase ID token.
2. It opens a WebSocket and sends the token in the first `auth` event, not in the URL.
3. The backend verifies the token, revocation, expiry, and anonymous provider.
4. It stores or updates the user profile, returns the verified identity, and loads the latest history page.
5. A message contains a client-generated UUID and text. The backend supplies the authenticated UID, guest name, and timestamp.
6. A Firestore transaction saves the message before the backend broadcasts it and acknowledges delivery.
7. Retrying the same UUID and text returns the existing record. Reusing an ID with different text is rejected.

Message document IDs are derived from the authenticated UID and client UUID. History uses a timestamp and document ID cursor, preserving nanoseconds for pagination. The frontend merges history, broadcasts, and acknowledgments by message ID.

Messages are plain text, limited to 2,000 UTF-16 code units. Sending is limited to 10 messages per 10 seconds per UID. Drafts and pending messages remain in memory during a reconnect; a full page reload restores persisted messages.

### Stored data

| Collection | Document ID | Fields |
| --- | --- | --- |
| `users` | Firebase UID | `uid`, `displayName`, `isAnonymous`, `createdAt`, `lastSeenAt` |
| `messages` | SHA-256 of UID and client UUID | `clientId`, `uid`, `displayName`, `text`, `createdAt` |

Timestamps are generated by the backend and stored as Firestore `Timestamp` values. The transport sends ISO date strings. A returning user's creation timestamp is preserved.

### WebSocket events

| Direction | Event | Purpose |
| --- | --- | --- |
| Client to server | `auth` | Authenticate a Firebase ID token |
| Client to server | `message:send` | Send a client UUID and message text |
| Client to server | `history:request` | Request an older page with a cursor and request ID |
| Server to client | `session:ready` | Return the verified user |
| Server to client | `history:page` | Return messages and the next cursor |
| Server to client | `message:new` | Broadcast a persisted message |
| Server to client | `message:ack` | Confirm persistence |
| Server to client | `error` | Return a code, message, and relevant operation ID |

The complete contract is defined in `backend/src/protocol.ts`.

## Manual verification

1. Open the chat in two independent browser sessions and confirm different guest identities.
2. Send messages in both directions and check that both clients receive them.
3. Inspect Authentication users and the Firestore `users` and `messages` collections.
4. Reload the page and restart the backend; persisted history should remain.
5. Stop and restart the backend to check reconnection and draft preservation.
6. Create more than 50 messages while respecting the sending limit, then load older pages.

## Optional Firebase emulators

Use JDK 21 or later and the Firebase CLI for local emulator development. See the [Emulator Suite setup guide](https://firebase.google.com/docs/emulator-suite/install_and_configure).

```sh
npm install --global firebase-tools
firebase emulators:start --only auth,firestore --project demo-anonymous-chat
```

Use the following frontend configuration:

```dotenv
VITE_FIREBASE_API_KEY=demo-api-key
VITE_FIREBASE_AUTH_DOMAIN=demo-anonymous-chat.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=demo-anonymous-chat
VITE_FIREBASE_APP_ID=demo-app-id
VITE_WS_URL=ws://localhost:3001/ws
VITE_USE_FIREBASE_EMULATORS=true
```

Set `FIREBASE_PROJECT_ID=demo-anonymous-chat` in the backend, remove `GOOGLE_APPLICATION_CREDENTIALS`, and enable both emulator hosts:

```dotenv
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
```

Start the applications with `npm run dev` in another terminal. The emulator UI is available at `http://127.0.0.1:4000`. Emulator data is temporary unless export is configured. Disable emulator variables and restore the real project configuration before returning to cloud Firebase.

## Troubleshooting

| Problem | Check |
| --- | --- |
| `Connect your room` screen | Fill in `frontend/.env` and restart Vite |
| Anonymous sign-in is disabled | Enable the Anonymous provider in Authentication |
| Session cannot be verified | Confirm the project IDs, Admin credentials, and anonymous provider |
| History is unavailable | Confirm the default Firestore database and the service account's IAM permissions |
| Continuous reconnection | Check the backend, WebSocket URL, and allowed frontend origin |
| Credentials cannot be read | Check the JSON path relative to `backend/` |
| Port 5173 is in use | Free the port or update the Vite port and allowed origins together |
| Sending is rate limited | Wait a few seconds, then retry |

`/health` confirms HTTP liveness only; it does not check Firebase connectivity.

## Deployment considerations

This implementation broadcasts within one backend process. Multiple backend instances require shared event delivery and distributed rate limiting.

For deployment, serve `frontend/dist` through a static host and run the built backend on a Node.js host with WebSocket support. Set `NODE_ENV=production`, use `HOST=0.0.0.0` where required, configure exact `CLIENT_ORIGINS`, and build the frontend with a secure `VITE_WS_URL=wss://your-backend.example/ws`.

Use HTTPS/WSS and configure the proxy to support WebSocket upgrades with an idle timeout longer than the 30-second heartbeat interval. Keep Firebase Admin credentials on the backend. Anonymous sign-in creates Firebase identities; every participant can see the shared room's messages.
