import { spawn } from "node:child_process";

import type { DockerTargetExecFile } from "./dockerTarget.js";

const ERROR = "Docker target command failed";
const OUTPUT_CAP = 65_536;
const TERM_GRACE_MS = 50;
const KILL_GRACE_MS = 250;

export type DockerTargetExecutionFailureKind = "aborted" | "cleanup_failed" | "failed" | "timeout";

export class DockerTargetExecutionError extends Error {
  public readonly kind: DockerTargetExecutionFailureKind;
  public constructor(kind: DockerTargetExecutionFailureKind) {
    super(ERROR);
    this.name = "DockerTargetExecutionError";
    this.kind = kind;
  }
}

export class DockerTargetCommandFailure extends DockerTargetExecutionError {
  public readonly code: number;
  public readonly stderr: string;
  public readonly stdoutBytes: number;
  public constructor(code: number, stderr: string, stdoutBytes: number) {
    super("failed");
    this.name = "DockerTargetCommandFailure";
    this.code = code;
    this.stderr = stderr;
    this.stdoutBytes = stdoutBytes;
  }
}

const decode = (chunks: readonly Buffer[]): string => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new DockerTargetExecutionError("failed"); }
};

/**
 * Docker target probe/build transport with exact stdin and bounded tree teardown.
 * POSIX children lead a private process group so timeout/abort cannot strand a
 * buildx descendant that inherited the CLI's stdio handles.
 */
export const createBoundedDockerTargetExecFile = (): DockerTargetExecFile =>
  (file, args, options) => {
    if (typeof file !== "string" || file.length < 1 || file.includes("\0")
      || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      || !options || !Number.isSafeInteger(options.timeout) || options.timeout < 1
      || options.timeout > 120_000
      || options.signal !== undefined && !(options.signal instanceof AbortSignal)
      || options.stdin !== undefined && !(options.stdin instanceof Uint8Array)) {
      return Promise.reject(new DockerTargetExecutionError("failed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new DockerTargetExecutionError("aborted"));
    }
    return new Promise((resolve, reject) => {
      const grouped = process.platform !== "win32";
      let child;
      try {
        child = spawn(file, args, {
          detached: grouped,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(new DockerTargetExecutionError("failed"));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminal: DockerTargetExecutionError | undefined;
      let settled = false;
      let termTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const groupAbsent = (): boolean => {
        if (!grouped || !child.pid) return false;
        try { process.kill(-child.pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      };
      const signalTree = (signal: NodeJS.Signals): void => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* only a later ESRCH liveness probe proves quiescence */ }
      };
      const destroyPipes = (): void => {
        child.stdin.on("error", () => undefined);
        child.stdout.on("error", () => undefined);
        child.stderr.on("error", () => undefined);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error: DockerTargetExecutionError, unresolved = false): void => {
        if (settled || !unresolved && !groupAbsent()) return;
        settled = true;
        cleanup();
        destroyPipes();
        reject(error);
      };
      const terminate = (kind: DockerTargetExecutionFailureKind): void => {
        if (terminal || settled) return;
        terminal = new DockerTargetExecutionError(kind);
        signalTree("SIGTERM");
        termTimer = setTimeout(() => {
          signalTree("SIGKILL");
          destroyPipes();
          const started = Date.now();
          const poll = (): void => {
            if (!terminal || settled) return;
            if (groupAbsent()) { finish(terminal); return; }
            signalTree("SIGKILL");
            if (Date.now() - started >= KILL_GRACE_MS) {
              finish(new DockerTargetExecutionError("cleanup_failed"), true);
              return;
            }
            killTimer = setTimeout(poll, 10);
          };
          poll();
        }, TERM_GRACE_MS);
      };
      const append = (target: Buffer[], chunk: unknown, output: "stderr" | "stdout"): void => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (output === "stdout") stdoutBytes += value.byteLength;
        else stderrBytes += value.byteLength;
        if (stdoutBytes > OUTPUT_CAP || stderrBytes > OUTPUT_CAP) { terminate("failed"); return; }
        target.push(Buffer.from(value));
      };
      function onAbort(): void { terminate("aborted"); }
      child.stdout.on("data", (chunk) => append(stdout, chunk, "stdout"));
      child.stderr.on("data", (chunk) => append(stderr, chunk, "stderr"));
      child.stdin.on("error", () => terminate("failed"));
      child.on("error", () => terminate("failed"));
      child.on("close", (code) => {
        if (terminal || settled) return;
        settled = true;
        cleanup();
        try {
          const stderrText = decode(stderr);
          const stdoutText = decode(stdout);
          if (code !== 0) {
            reject(new DockerTargetCommandFailure(
              code ?? -1, stderrText, Buffer.byteLength(stdoutText, "utf8"),
            ));
            return;
          }
          resolve({ stderr: stderrText, stdout: stdoutText });
        }
        catch (error) { reject(error); }
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutTimer = setTimeout(() => terminate("timeout"), options.timeout);
      if (options.signal?.aborted) { terminate("aborted"); return; }
      try {
        const input = options.stdin === undefined ? undefined
          : Buffer.from(options.stdin.buffer, options.stdin.byteOffset, options.stdin.byteLength);
        child.stdin.end(input);
      } catch { terminate("failed"); }
    });
  };

export const defaultDockerTargetExecFile = createBoundedDockerTargetExecFile();
