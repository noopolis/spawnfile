import { SpawnfileError } from "../../../shared/index.js";

/** Gives the turn back; idempotent. */
export type ReleaseRealmTurn = () => void;

export interface RealmTurnOptions {
  /** Called once on the holder when another caller starts waiting: a warm holder should hand the turn over. */
  onContended?: () => void;
  /** Bound on the wait; on expiry the caller is refused instead of waiting forever. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * First-come turns on exclusive login realms, one holder per realm at a time.
 * An engine whose login is one realm held under an exclusive lock (Daimon's
 * AGY keyring, `flock` on `.daimon-lease`) admits one container per login:
 * every container of a run that mounts that realm takes a turn here first, so
 * a second container never boots into the lock and dies at readiness.
 */
export interface RealmTurns {
  take(realm: string, options?: RealmTurnOptions): Promise<ReleaseRealmTurn>;
}

interface Waiter { grant: () => void; options: RealmTurnOptions }
interface Realm { holder: RealmTurnOptions | null; contended: boolean; queue: Waiter[] }

export const createRealmTurns = (): RealmTurns => {
  const realms = new Map<string, Realm>();
  const release = (key: string, state: Realm): ReleaseRealmTurn => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.queue.shift();
      if (!next) { realms.delete(key); return; }
      state.holder = next.options;
      state.contended = false;
      next.grant();
      if (state.queue.length > 0) notify(state);
    };
  };
  const notify = (state: Realm): void => {
    if (state.contended) return;
    state.contended = true;
    state.holder?.onContended?.();
  };
  return {
    take: (key, options = {}) => {
      if (options.signal?.aborted) return Promise.reject(new SpawnfileError("runtime_error", `cancelled waiting for login realm ${key}`));
      const state = realms.get(key);
      if (!state) {
        const fresh: Realm = { holder: options, contended: false, queue: [] };
        realms.set(key, fresh);
        return Promise.resolve(release(key, fresh));
      }
      return new Promise<ReleaseRealmTurn>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const leave = (message: string): void => {
          const index = state.queue.indexOf(waiter);
          if (index < 0) return;
          state.queue.splice(index, 1);
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(new SpawnfileError("runtime_error", message));
        };
        const onAbort = (): void => leave(`cancelled waiting for login realm ${key}`);
        const waiter: Waiter = {
          options,
          grant: () => {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve(release(key, state));
          }
        };
        state.queue.push(waiter);
        if (options.timeoutMs !== undefined) {
          timer = setTimeout(() => leave(`login realm ${key} stayed held by another container for ${options.timeoutMs}ms; one login admits one container at a time`), options.timeoutMs);
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        notify(state);
      });
    }
  };
};
