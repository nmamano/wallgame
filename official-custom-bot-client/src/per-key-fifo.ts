/**
 * Serializes work for one key while leaving different keys independent.
 *
 * The stored tail never rejects, so a failed task cannot poison its successor.
 * Callers still receive the task's original rejection. Cleanup compares tail
 * identity so an older completion cannot delete a newer queued tail.
 */
export class PerKeyFifo<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  enqueue(key: Key, task: () => Promise<void>): Promise<void> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    const result = predecessor.then(task);
    const tail = result.catch(() => undefined);

    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });

    return result;
  }

  /** Visible only as a property so tests can prove identity-safe cleanup. */
  get size(): number {
    return this.tails.size;
  }
}
