import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  createOrganizationHandoffAuthorityError, parseOrganizationHandoffAuthorityFailureDetail,
  PUBLICATION_BUDGET_MS, type OrganizationHandoffAuthorityFailureDetail
} from "./organizationHandoffAuthorityFsBudget.js";

const VERSION = "spawnfile.organization-handoff-fs-worker.v1";
const MAX_BYTES = 32_768;
/**
 * The client deadline must exceed the worker's own convergence budget, or the
 * client times out first and replaces a diagnosable worker failure with an
 * opaque one. The margin covers fork/IPC latency and event-loop lag.
 */
const REQUEST_DEADLINE_MS = PUBLICATION_BUDGET_MS + 3_000;
/**
 * Startup deadline for the worker's ready handshake. This bounds a hung or
 * broken helper; it is not a latency budget for process startup. Several
 * helpers are forked concurrently and a loaded host schedules their
 * interpreter startup slowly, so it is sized for a saturated machine.
 */
const READY_DEADLINE_MS = 20_000;
const DISPOSE_GRACE_MS = 1_000;

const fail = (code: string, state?: string): never => {
  throw createOrganizationHandoffAuthorityError({ code, ...(state === undefined ? {} : { state }) });
};
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const name = (value: unknown): string => typeof value === "string" && /^(?:[a-f0-9]{128}|[a-f0-9]{142})\.json$/u.test(value) ? value : fail("invalid_name");

export interface OrganizationHandoffAuthorityFsClientOptions {
  readonly cwd: string;
  readonly dev: number;
  readonly ino: number;
  readonly parentPid?: number;
  readonly uid?: number;
  readonly workerPath?: string;
  // Test-only observation seam; callers cannot control the child through the
  // authority client API.
  readonly testOnChildStarted?: (child: ChildProcess) => void;
}
export interface OrganizationHandoffAuthorityFsClient {
  create(name: string, content: string): Promise<boolean>;
  dispose(): Promise<void>;
  read(name: string): Promise<string | null>;
  write(name: string, content: string): Promise<void>;
}

type Pending = {
  reject(detail?: OrganizationHandoffAuthorityFailureDetail): void;
  resolve(value: { content?: string; created?: boolean }): void;
};

class Client implements OrganizationHandoffAuthorityFsClient {
  readonly #child: ChildProcess; #closed = false; #next = 1;
  readonly #exited: Promise<void>;
  readonly #pending = new Map<number, Pending>();
  public constructor(child: ChildProcess) {
    this.#child = child;
    let settleExit!: () => void;
    this.#exited = new Promise<void>((resolve) => { settleExit = resolve; });
    const settle = (): void => { this.rejectPending("worker_exited"); settleExit(); };
    child.on("message", (raw: unknown) => this.message(raw));
    child.on("error", () => this.rejectPending("worker_errored"));
    child.on("disconnect", () => this.rejectPending("worker_disconnected"));
    child.once("exit", settle);
    if (child.exitCode !== null || child.signalCode !== null) settle();
    // `fork(..., { silent: true })` creates pipes. Consume them so a failing
    // helper cannot block on a full pipe or accumulate stream listeners.
    child.stdout?.resume(); child.stderr?.resume();
  }
  private terminal(): boolean { return this.#child.exitCode !== null || this.#child.signalCode !== null; }
  private rejectPending(code: string): void {
    for (const pending of this.#pending.values()) pending.reject({ code });
    this.#pending.clear();
  }
  private message(raw: unknown): void {
    if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
    if (value.version !== VERSION) return;
    if (value.ready === true) return;
    if (!Number.isSafeInteger(value.id) || typeof value.ok !== "boolean") return;
    const pending = this.#pending.get(value.id as number); if (!pending) return; this.#pending.delete(value.id as number);
    if (value.ok !== true || value.content !== undefined && typeof value.content !== "string"
      || value.created !== undefined && typeof value.created !== "boolean") {
      // The worker reports which budget or invariant failed. Preserve it: a
      // bare failure here is what made this path undiagnosable from CI logs.
      pending.reject(parseOrganizationHandoffAuthorityFailureDetail(value.failure) ?? { code: "worker_rejected" });
      return;
    }
    pending.resolve(value as { content?: string; created?: boolean });
  }
  private request(op: "create" | "read" | "write", file: string, content?: string): Promise<{ content?: string; created?: boolean }> {
    if (this.#closed) return Promise.reject(createOrganizationHandoffAuthorityError({ code: "client_closed" }));
    if (content !== undefined && bytes(content) > MAX_BYTES) return Promise.reject(createOrganizationHandoffAuthorityError({ code: "content_too_large", state: `bytes=${bytes(content)} limit=${MAX_BYTES}` }));
    const id = this.#next++; const packet = { version: VERSION, id, op, name: name(file), ...(content === undefined ? {} : { content }) };
    const size = bytes(JSON.stringify(packet));
    if (size > MAX_BYTES) return Promise.reject(createOrganizationHandoffAuthorityError({ code: "packet_too_large", state: `bytes=${size} limit=${MAX_BYTES}` }));
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const settle = (detail?: OrganizationHandoffAuthorityFailureDetail): void => {
        clearTimeout(timer);
        reject(createOrganizationHandoffAuthorityError(detail ?? { code: "request_failed" }));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        settle({ budget: "client_request", code: "client_request_deadline", elapsedMs: performance.now() - startedAt, limitMs: REQUEST_DEADLINE_MS, state: `op=${op}` });
      }, REQUEST_DEADLINE_MS);
      this.#pending.set(id, {
        reject: (detail) => settle(detail === undefined ? detail : { ...detail, state: `${detail.state === undefined ? "" : `${detail.state} `}op=${op}` }),
        resolve: (value) => { clearTimeout(timer); resolve(value); }
      });
      if (!this.#child.send(packet)) {
        clearTimeout(timer); this.#pending.delete(id);
        reject(createOrganizationHandoffAuthorityError({ code: "worker_send_failed", state: `op=${op}` }));
      }
    });
  }
  public async create(file: string, content: string): Promise<boolean> {
    const result = await this.request("create", file, content);
    return result.created === true;
  }
  public async read(file: string): Promise<string | null> { return (await this.request("read", file)).content ?? null; }
  public async write(file: string, content: string): Promise<void> { await this.request("write", file, content); }
  public async dispose(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.rejectPending("client_disposed");
    if (!this.terminal()) {
      if (this.#child.connected) { try { this.#child.disconnect(); } catch { /* already disconnected */ } }
      this.#child.kill();
    }
    let clear: (() => void) | undefined;
    const graceful = await Promise.race([this.#exited.then(() => true), new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), DISPOSE_GRACE_MS); clear = () => clearTimeout(timer);
    })]);
    clear?.();
    if (!graceful && !this.terminal()) this.#child.kill("SIGKILL");
    await this.#exited;
    this.#child.stdout?.destroy(); this.#child.stderr?.destroy();
  }
}

export const initializeOrganizationHandoffAuthorityFsClient = async (options: OrganizationHandoffAuthorityFsClientOptions): Promise<OrganizationHandoffAuthorityFsClient> => {
  const source = import.meta.url.endsWith(".ts");
  const workerPath = options.workerPath ?? fileURLToPath(new URL(source ? "./organizationHandoffAuthorityFsWorker.ts" : "./organizationHandoffAuthorityFsWorker.js", import.meta.url));
  const tsWorker = workerPath.endsWith(".ts");
  // The helper's cwd is the protected state directory, which is intentionally
  // outside the repository. Resolve the source loader before changing cwd so
  // source-mode tests do not depend on module lookup from that directory.
  const tsxLoader = tsWorker ? createRequire(import.meta.url).resolve("tsx") : undefined;
  const child = fork(workerPath, [], { cwd: options.cwd, env: { SPAWNFILE_AUTHORITY_FS_ANCHOR: JSON.stringify({ dev: options.dev, ino: options.ino, uid: options.uid, parent_pid: options.parentPid ?? process.pid }) }, silent: true, ...(tsxLoader === undefined ? {} : { execArgv: ["--import", tsxLoader] }) });
  const client = new Client(child);
  options.testOnChildStarted?.(child);
  const startedAt = performance.now();
  let detail: OrganizationHandoffAuthorityFailureDetail = { code: "worker_ready_failed" };
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const message = (raw: unknown): void => { if (typeof raw === "object" && raw !== null && (raw as { ready?: unknown }).ready === true) doneResolve(); };
      const exited = (): void => doneReject("worker_exited_before_ready");
      const errored = (): void => doneReject("worker_errored_before_ready");
      const clean = (): void => { clearTimeout(timer); child.off("message", message); child.off("exit", exited); child.off("error", errored); };
      function doneResolve(): void { clean(); resolve(); }
      function doneReject(code: string): void {
        clean();
        detail = { budget: "worker_ready", code, elapsedMs: performance.now() - startedAt, limitMs: READY_DEADLINE_MS, state: `source=${String(tsWorker)}` };
        reject(createOrganizationHandoffAuthorityError(detail));
      }
      timer = setTimeout(() => doneReject("worker_ready_deadline"), READY_DEADLINE_MS);
      child.on("message", message); child.once("exit", exited); child.once("error", errored);
    });
    return client;
  } catch {
    await client.dispose();
    throw createOrganizationHandoffAuthorityError(detail);
  }
};
