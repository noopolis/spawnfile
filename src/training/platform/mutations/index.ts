/** Serializes complete read/change/publish transactions, including failures. */
export class MutationQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
