import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export function initializeFirebase(projectId: string, emulatorEnabled: boolean) {
  const app = initializeApp({
    projectId,
    ...(emulatorEnabled ? {} : { credential: applicationDefault() }),
  });
  return { auth: getAuth(app), db: getFirestore(app) };
}
