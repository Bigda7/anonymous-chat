import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  FIREBASE_PROJECT_ID: z
    .string()
    .min(1)
    .refine(
      (value) => value !== 'your-project-id',
      'Replace your-project-id with your Firebase project ID.',
    ),
  CLIENT_ORIGINS: z.string().default('http://localhost:5173'),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
});

export function loadConfig() {
  const result = environmentSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid backend configuration: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const env = result.data;
  const emulatorEnabled = Boolean(env.FIREBASE_AUTH_EMULATOR_HOST);
  if (emulatorEnabled !== Boolean(env.FIRESTORE_EMULATOR_HOST)) {
    throw new Error('Configure both Firebase emulators together.');
  }
  if (env.NODE_ENV === 'production' && emulatorEnabled) {
    throw new Error('Firebase emulators cannot be enabled in production.');
  }
  const origins = env.CLIENT_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    origins.length === 0 ||
    origins.some((origin) => {
      try {
        const url = new URL(origin);
        return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error('CLIENT_ORIGINS must contain exact HTTP(S) origins without trailing slashes.');
  }
  return {
    port: env.PORT,
    host: env.HOST,
    projectId: env.FIREBASE_PROJECT_ID,
    origins,
    emulatorEnabled,
  };
}
