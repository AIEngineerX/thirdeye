/**
 * BYOK (Bring Your Own Key) storage helpers.
 *
 * Persists the user-supplied Helius API key in localStorage so it survives
 * reloads and rides on every authenticated request via headers.
 *
 * Pure-logic functions take a Storage backend so they can be unit-tested with
 * an in-memory shim. Production callers use `getByokStore()` which binds to
 * `window.localStorage` and bridges cross-tab `storage` events into local
 * subscribers.
 */

export type ByokKind = "helius";

const KEY_PREFIX = "thirdeye.byok.";

export interface ByokSnapshot {
  helius: string | null;
}

export interface ByokStore {
  get(kind: ByokKind): string | null;
  set(kind: ByokKind, value: string): void;
  clear(kind: ByokKind): void;
  snapshot(): ByokSnapshot;
  subscribe(listener: (snapshot: ByokSnapshot) => void): () => void;
}

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function keyFor(kind: ByokKind): string {
  return `${KEY_PREFIX}${kind}`;
}

/**
 * Build a ByokStore against an arbitrary Storage backend. When `storage` is
 * null (SSR), the store is read-only-empty — set/clear become no-ops and
 * reads return null. Listeners fire on local set/clear AND when `emit()` is
 * invoked externally (used to bridge cross-tab `storage` events).
 */
export function createByokStore(storage: MinimalStorage | null): ByokStore & {
  emit: () => void;
} {
  const listeners = new Set<(snap: ByokSnapshot) => void>();

  const read = (kind: ByokKind): string | null => {
    if (!storage) return null;
    const raw = storage.getItem(keyFor(kind));
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const snapshot = (): ByokSnapshot => ({
    helius: read("helius"),
  });

  const emit = (): void => {
    const snap = snapshot();
    for (const l of listeners) l(snap);
  };

  return {
    get: read,
    set(kind, value) {
      if (!storage) return;
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        storage.removeItem(keyFor(kind));
      } else {
        storage.setItem(keyFor(kind), trimmed);
      }
      emit();
    },
    clear(kind) {
      if (!storage) return;
      storage.removeItem(keyFor(kind));
      emit();
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit,
  };
}

let cachedStore: (ByokStore & { emit: () => void }) | null = null;

/**
 * Browser singleton bound to `window.localStorage`. Subsequent calls return
 * the same instance. Cross-tab `storage` events trigger listeners so two
 * open tabs see each other's settings changes.
 */
export function getByokStore(): ByokStore {
  if (cachedStore) return cachedStore;
  const storage = typeof window !== "undefined" ? window.localStorage : null;
  cachedStore = createByokStore(storage);

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      // e.key === null means storage.clear() — emit unconditionally. Else
      // only fan out when one of our prefixed keys moved.
      if (e.key === null || e.key.startsWith(KEY_PREFIX)) {
        cachedStore!.emit();
      }
    });
  }
  return cachedStore;
}

/** Convenience for non-reactive callers (e.g. fetch header builder). */
export function getByokSnapshot(): ByokSnapshot {
  return getByokStore().snapshot();
}
