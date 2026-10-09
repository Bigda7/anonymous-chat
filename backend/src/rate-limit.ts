export class RateLimiter {
  private readonly entries = new Map<string, { count: number; startedAt: number }>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()) {
    const existing = this.entries.get(key);
    if (!existing || now - existing.startedAt >= this.windowMs) {
      this.entries.set(key, { count: 1, startedAt: now });
      return true;
    }
    if (existing.count >= this.maximum) return false;
    existing.count += 1;
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.startedAt >= this.windowMs) this.entries.delete(key);
    }
  }
}
