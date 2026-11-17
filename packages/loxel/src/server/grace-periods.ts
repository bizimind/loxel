/**
 * Ends things a while after their last user left, unless a user comes back first: a worktree's
 * resources once its last window unsubscribed, a language server once its socket closed.
 */
export class GracePeriods<K> {
  private readonly timers = new Map<K, ReturnType<typeof setTimeout>>();

  constructor(readonly ms: number) {}

  /** Run `end` for `key` once the period has passed, unless cancelled first. Replaces a pending one. */
  start(key: K, end: () => void): void {
    this.cancel(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        end();
      }, this.ms),
    );
  }

  /** Whether `key`'s period is running. */
  has(key: K): boolean {
    return this.timers.has(key);
  }

  /** Stop `key`'s period without running its end. True when one was running. */
  cancel(key: K): boolean {
    const timer = this.timers.get(key);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.timers.delete(key);
    return true;
  }

  /** Stop every period without running their ends. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
