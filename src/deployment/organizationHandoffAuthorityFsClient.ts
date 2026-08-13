import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const VERSION = "spawnfile.organization-handoff-fs-worker.v1";
const MAX_BYTES = 32_768;
const fail = (): never => { throw new Error("Organization handoff authority failed"); };
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const name = (value: unknown): string => typeof value === "string" && /^(?:[a-f0-9]{128}|[a-f0-9]{142})\.json$/u.test(value) ? value : fail();

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

class Client implements OrganizationHandoffAuthorityFsClient {
  readonly #child: ChildProcess; #closed = false; #next = 1;
  readonly #exited: Promise<void>;
  readonly #pending = new Map<number, { reject(): void; resolve(value: { content?: string; created?: boolean }): void }>();
  public constructor(child: ChildProcess) {
    this.#child = child;
    let settleExit!: () => void;
    this.#exited = new Promise<void>((resolve) => { settleExit = resolve; });
    const settle = (): void => { this.rejectPending(); settleExit(); };
    child.on("message", (raw: unknown) => this.message(raw));
    child.on("error", () => this.rejectPending());
    child.on("disconnect", () => this.rejectPending());
    child.once("exit", settle);
    if (child.exitCode !== null || child.signalCode !== null) settle();
    // `fork(..., { silent: true })` creates pipes. Consume them so a failing
    // helper cannot block on a full pipe or accumulate stream listeners.
    child.stdout?.resume(); child.stderr?.resume();
  }
  private terminal(): boolean { return this.#child.exitCode !== null || this.#child.signalCode !== null; }
  private rejectPending(): void { for (const pending of this.#pending.values()) pending.reject(); this.#pending.clear(); }
  private message(raw: unknown): void {
    if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
    if (value.version !== VERSION) return;
    if (value.ready === true) return;
    if (!Number.isSafeInteger(value.id) || typeof value.ok !== "boolean") return;
    const pending = this.#pending.get(value.id as number); if (!pending) return; this.#pending.delete(value.id as number);
    if (value.ok !== true || value.content !== undefined && typeof value.content !== "string"
      || value.created !== undefined && typeof value.created !== "boolean") pending.reject(); else pending.resolve(value as { content?: string; created?: boolean });
  }
  private request(op: "create" | "read" | "write", file: string, content?: string): Promise<{ content?: string; created?: boolean }> {
    if (this.#closed || content !== undefined && bytes(content) > MAX_BYTES) return Promise.reject(new Error("Organization handoff authority failed"));
    const id = this.#next++; const packet = { version: VERSION, id, op, name: name(file), ...(content === undefined ? {} : { content }) };
    if (bytes(JSON.stringify(packet)) > MAX_BYTES) return Promise.reject(new Error("Organization handoff authority failed"));
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("Organization handoff authority failed")); }, 3_000); this.#pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: () => { clearTimeout(timer); reject(new Error("Organization handoff authority failed")); } }); if (!this.#child.send(packet)) { clearTimeout(timer); this.#pending.delete(id); reject(new Error("Organization handoff authority failed")); } });
  }
  public async create(file: string, content: string): Promise<boolean> {
    const result = await this.request("create", file, content);
    return result.created === true;
  }
  public async read(file: string): Promise<string | null> { return (await this.request("read", file)).content ?? null; }
  public async write(file: string, content: string): Promise<void> { await this.request("write", file, content); }
  public async dispose(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.rejectPending();
    if (!this.terminal()) {
      if (this.#child.connected) { try { this.#child.disconnect(); } catch { /* already disconnected */ } }
      this.#child.kill();
    }
    let clear: (() => void) | undefined;
    const graceful = await Promise.race([this.#exited.then(() => true), new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_000); clear = () => clearTimeout(timer);
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
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const message = (raw: unknown): void => { if (typeof raw === "object" && raw !== null && (raw as { ready?: unknown }).ready === true) doneResolve(); };
      const exited = (): void => doneReject(); const errored = (): void => doneReject();
      const clean = (): void => { clearTimeout(timer); child.off("message", message); child.off("exit", exited); child.off("error", errored); };
      function doneResolve(): void { clean(); resolve(); }
      function doneReject(): void { clean(); reject(new Error("Organization handoff authority failed")); }
      timer = setTimeout(doneReject, 3_000);
      child.on("message", message); child.once("exit", exited); child.once("error", errored);
    });
    return client;
  } catch { await client.dispose(); return fail(); }
};
