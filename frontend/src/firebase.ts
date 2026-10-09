import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
  signInAnonymously,
  type User,
} from 'firebase/auth';

const requiredKeys = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

export const missingFirebaseKeys = requiredKeys.filter((key) => {
  const value: unknown = import.meta.env[key];
  return (
    typeof value !== 'string' || !value.trim() || /^(replace-with|your-project-id)/.test(value)
  );
});

let signInPromise: Promise<User> | undefined;

export function ensureAnonymousUser(): Promise<User> {
  if (signInPromise) return signInPromise;
  signInPromise = (async () => {
    if (missingFirebaseKeys.length) throw new Error('Firebase configuration is incomplete.');
    const app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    });
    const auth = getAuth(app);
    if (import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true') {
      if (!import.meta.env.DEV) throw new Error('Auth emulation is only allowed in development.');
      connectAuthEmulator(auth, 'http://127.0.0.1:9099');
    }
    await setPersistence(auth, browserLocalPersistence);
    await auth.authStateReady();
    if (auth.currentUser?.isAnonymous) return auth.currentUser;
    return (await signInAnonymously(auth)).user;
  })();
  return signInPromise;
}

export function webSocketUrl() {
  const url = new URL(import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws');
  if (!['ws:', 'wss:'].includes(url.protocol))
    throw new Error('VITE_WS_URL must use ws:// or wss://.');
  if (window.location.protocol === 'https:' && url.protocol !== 'wss:') {
    throw new Error('Use a secure WebSocket URL with HTTPS.');
  }
  return url.toString();
}
