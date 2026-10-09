import { FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { MessageConflictError, guestName, messageDocumentId } from './domain.js';
import {
  HISTORY_PAGE_SIZE,
  chatMessageSchema,
  type ChatMessage,
  type ChatUser,
  type HistoryCursor,
  type HistoryPage,
} from './protocol.js';

export interface ChatStore {
  upsertUser(uid: string): Promise<ChatUser>;
  getHistory(before?: HistoryCursor): Promise<HistoryPage>;
  saveMessage(
    user: ChatUser,
    clientId: string,
    text: string,
  ): Promise<{ message: ChatMessage; created: boolean }>;
}

function readMessage(id: string, data: Record<string, unknown> | undefined): ChatMessage {
  if (!data || !(data.createdAt instanceof Timestamp)) {
    throw new Error('Invalid stored message timestamp.');
  }
  return chatMessageSchema.parse({ ...data, id, createdAt: data.createdAt.toDate().toISOString() });
}

export function createFirestoreStore(db: Firestore): ChatStore {
  return {
    async upsertUser(uid) {
      const user = { uid, displayName: guestName(uid) };
      const reference = db.collection('users').doc(uid);
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(reference);
        const now = Timestamp.now();
        transaction.set(
          reference,
          {
            ...user,
            isAnonymous: true,
            lastSeenAt: now,
            ...(existing.exists ? {} : { createdAt: now }),
          },
          { merge: true },
        );
      });
      return user;
    },

    async getHistory(before) {
      let query = db
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .orderBy(FieldPath.documentId(), 'desc');
      if (before) {
        query = query.startAfter(new Timestamp(before.seconds, before.nanoseconds), before.id);
      }
      const snapshot = await query.limit(HISTORY_PAGE_SIZE + 1).get();
      const documents = snapshot.docs.slice(0, HISTORY_PAGE_SIZE);
      const oldest = documents.at(-1);
      const timestamp: unknown = oldest?.get('createdAt');
      const hasMore = snapshot.size > HISTORY_PAGE_SIZE;
      return {
        messages: documents.map((document) => readMessage(document.id, document.data())).reverse(),
        nextCursor:
          hasMore && oldest && timestamp instanceof Timestamp
            ? { id: oldest.id, seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds }
            : null,
      };
    },

    async saveMessage(user, clientId, text) {
      const reference = db.collection('messages').doc(messageDocumentId(user.uid, clientId));
      return db.runTransaction(async (transaction) => {
        const existing = await transaction.get(reference);
        if (existing.exists) {
          const message = readMessage(existing.id, existing.data());
          if (message.text !== text) {
            throw new MessageConflictError('A client ID cannot be reused with different text.');
          }
          return { message, created: false };
        }
        const createdAt = Timestamp.now();
        const data = { ...user, clientId, text, createdAt };
        transaction.create(reference, data);
        return {
          message: { ...data, id: reference.id, createdAt: createdAt.toDate().toISOString() },
          created: true,
        };
      });
    },
  };
}
