/**
 * A minimal `window.localStorage` for client tests.
 *
 * Imported for its side effect, and it must be the **first** import in any
 * test that pulls in a client module: esbuild emits `require` calls in source
 * order, so a module that reads `window` while it initialises would otherwise
 * see nothing.
 *
 * Deliberately not a full DOM. Only the pieces the storage-backed client code
 * actually touches are provided, so a test that starts depending on something
 * else fails loudly rather than silently exercising a stub.
 */
class MemoryStorage {
  private data = new Map<string, string>();

  /** Set to make every write throw, standing in for a full or private-mode quota. */
  public failWrites = false;

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) { throw new Error('QuotaExceededError'); }
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

export const storage = new MemoryStorage();

(globalThis as any).window = {
  localStorage: storage,
};
