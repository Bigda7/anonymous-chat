import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';
import { messageDocumentId } from '../src/domain.js';

describe('rate limits', () => {
  it('keeps users independent and resets the limit when the window ends', () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.allow('alice', 100)).toBe(true);
    expect(limiter.allow('alice', 101)).toBe(true);
    expect(limiter.allow('alice', 102)).toBe(false);
    expect(limiter.allow('bob', 102)).toBe(true);
    limiter.prune(1100);
    expect(limiter.allow('alice', 1100)).toBe(true);
  });
});

describe('message identity', () => {
  it('deduplicates retries for one user without colliding across users', () => {
    expect(messageDocumentId('alice', 'id')).toBe(messageDocumentId('alice', 'id'));
    expect(messageDocumentId('alice', 'id')).not.toBe(messageDocumentId('bob', 'id'));
  });
});
