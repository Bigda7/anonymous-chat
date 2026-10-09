import { createHash } from 'node:crypto';

export class MessageConflictError extends Error {}

export function messageDocumentId(uid: string, clientId: string) {
  return createHash('sha256').update(`${uid}:${clientId}`).digest('hex');
}

export function guestName(uid: string) {
  return `Guest ${createHash('sha256').update(uid).digest('hex').slice(0, 6).toUpperCase()}`;
}
