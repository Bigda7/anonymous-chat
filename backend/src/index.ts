import { loadConfig } from './config.js';
import { initializeFirebase } from './firebase.js';
import { createChatServer } from './server.js';
import { createFirestoreStore } from './store.js';

async function main() {
  const config = loadConfig();
  const { auth, db } = initializeFirebase(config.projectId, config.emulatorEnabled);
  const chat = createChatServer({
    store: createFirestoreStore(db),
    origins: config.origins,
    async verifyToken(token) {
      const decoded = await auth.verifyIdToken(token, true);
      if (decoded.firebase.sign_in_provider !== 'anonymous') {
        throw new Error('Only anonymous sessions are supported.');
      }
      return { uid: decoded.uid, expiresAt: decoded.exp * 1000 };
    },
  });

  await new Promise<void>((resolve, reject) => {
    chat.server.once('error', reject);
    chat.server.listen(config.port, config.host, () => {
      chat.server.removeListener('error', reject);
      resolve();
    });
  });
  console.info(`Chat server listening at http://${config.host}:${config.port}`);

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    const forcedExit = setTimeout(() => process.exit(1), 10000);
    forcedExit.unref();
    try {
      await chat.close();
      await db.terminate();
      clearTimeout(forcedExit);
    } catch {
      console.error('Could not shut down cleanly.');
      process.exitCode = 1;
    }
  }
  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Could not start the backend.');
  process.exitCode = 1;
});
