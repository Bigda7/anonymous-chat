import { z } from 'zod';

export const MAX_MESSAGE_LENGTH = 2000;
export const HISTORY_PAGE_SIZE = 50;

export const userSchema = z.object({
  uid: z.string().min(1).max(128),
  displayName: z.string().min(1).max(64),
});

export const cursorSchema = z.object({
  seconds: z.number().int().min(0).max(253402300799),
  nanoseconds: z.number().int().min(0).max(999999999),
  id: z.string().regex(/^[a-f0-9]{64}$/),
});

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  clientId: z.uuid(),
  uid: z.string().min(1),
  displayName: z.string().min(1),
  text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  createdAt: z.iso.datetime(),
});

export const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(8192) }).strict(),
  z
    .object({
      type: z.literal('message:send'),
      clientId: z.uuid(),
      text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    })
    .strict(),
  z
    .object({
      type: z.literal('history:request'),
      requestId: z.uuid(),
      before: cursorSchema,
    })
    .strict(),
]);

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session:ready'), user: userSchema }),
  z.object({
    type: z.literal('history:page'),
    requestId: z.string(),
    messages: z.array(chatMessageSchema),
    nextCursor: cursorSchema.nullable(),
  }),
  z.object({ type: z.literal('message:new'), message: chatMessageSchema }),
  z.object({ type: z.literal('message:ack'), message: chatMessageSchema }),
  z.object({
    type: z.literal('error'),
    code: z.enum([
      'AUTH_REQUIRED',
      'AUTH_FAILED',
      'INVALID_EVENT',
      'RATE_LIMITED',
      'STORAGE_UNAVAILABLE',
      'ID_CONFLICT',
      'SERVER_BUSY',
    ]),
    message: z.string(),
    clientId: z.string().optional(),
    requestId: z.string().optional(),
  }),
]);

export type ChatUser = z.infer<typeof userSchema>;
export type HistoryCursor = z.infer<typeof cursorSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type HistoryPage = { messages: ChatMessage[]; nextCursor: HistoryCursor | null };
