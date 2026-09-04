import { pbkdf2 } from "node:crypto";

/**
 * Test-only preload that delays the authority worker's startup filesystem call.
 *
 * The worker validates its anchor with an `lstat`, which libuv runs on the
 * threadpool. Forked with `UV_THREADPOOL_SIZE=1`, this preload occupies that
 * single slot long enough that the anchor cannot be established until well
 * after the worker's 100ms liveness watchdog has ticked several times — the
 * deterministic equivalent of what CPU contention does to worker startup on a
 * loaded host, and the condition under which the watchdog used to reap the
 * helper before it could ever report readiness.
 *
 * The event loop itself stays free throughout, so the watchdog does tick.
 */
const STALL_ITERATIONS = 1_500_000;

pbkdf2("spawnfile-stall", "spawnfile-stall", STALL_ITERATIONS, 64, "sha512", () => undefined);
