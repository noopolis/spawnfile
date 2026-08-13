import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";
import { types as nodeTypes } from "node:util";

export const DOCKER_COMMAND_ERROR = "Docker command failed";
export const DOCKER_TEXT_CAP = 32_768;
export const DOCKER_BINARY_CAP = 67_108_864;
const FALLBACK_MS = 50;

export interface SpawnedDockerCommand {
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly stdout: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  off(event: string, listener: (...args: never[]) => void): this;
  on(event: string, listener: (...args: never[]) => void): this;
  once(event: string, listener: (...args: never[]) => void): this;
}
export type DockerCommandSpawn = (
  file: string,
  args: readonly string[],
  options: { readonly shell: false; readonly stdio: ["pipe", "pipe", "pipe"] }
) => SpawnedDockerCommand;

export class DockerCommandFailure extends Error {
  public readonly code: number;
  public readonly stderr: string;
  public constructor(code: number, stderr: string) {
    super(DOCKER_COMMAND_ERROR);
    this.code = code;
    this.stderr = stderr;
  }
}

export interface DockerCommandCoreOptions {
  readonly binary: boolean;
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;
  readonly stdoutCap?: number;
  readonly timeout: number;
}
export interface DockerCommandCoreResult {
  readonly stderr: string;
  readonly stdout: string | Uint8Array;
}

const ordinaryOptions = (raw: unknown): raw is DockerCommandCoreOptions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeTypes.isProxy(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return false;
  const value = raw as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const names = (keys as string[]).sort();
  const data = Object.fromEntries(names.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return [key, descriptor && "value" in descriptor && descriptor.enumerable
      ? descriptor.value : Symbol("invalid")];
  }));
  if (!names.every((key) => ["binary", "signal", "stdin", "stdoutCap", "timeout"].includes(key))
    || !names.includes("binary") || !names.includes("timeout")
    || typeof data.binary !== "boolean"
    || data.stdoutCap !== undefined && (!Number.isSafeInteger(data.stdoutCap)
      || (data.stdoutCap as number) < 1
      || (data.stdoutCap as number) > (data.binary ? DOCKER_BINARY_CAP : DOCKER_TEXT_CAP))
    || !Number.isSafeInteger(data.timeout) || (data.timeout as number) < 1
    || (data.timeout as number) > 120_000
    || data.signal !== undefined && !(data.signal instanceof AbortSignal)
    || data.stdin !== undefined && (!(data.stdin instanceof Uint8Array)
      || nodeTypes.isProxy(data.stdin))) return false;
  return true;
};
const validate: (
  file: unknown,
  args: unknown,
  options: unknown
) => asserts options is DockerCommandCoreOptions = (file, args, options) => {
  if (typeof file !== "string" || file.length < 1 || file.length > 128 || file.includes("\0")
    || Buffer.from(file, "utf8").toString("utf8") !== file
    || !Array.isArray(args) || nodeTypes.isProxy(args)
    || Object.getPrototypeOf(args) !== Array.prototype || args.length > 1_024
    || !ordinaryOptions(options)) throw new Error(DOCKER_COMMAND_ERROR);
  const ownKeys = Reflect.ownKeys(args);
  if (ownKeys.length !== args.length + 1 || !ownKeys.includes("length")) {
    throw new Error(DOCKER_COMMAND_ERROR);
  }
  let total = 0;
  for (let index = 0; index < args.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(args, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(DOCKER_COMMAND_ERROR);
    }
    const arg = descriptor.value;
    if (typeof arg !== "string" || arg.includes("\0")
      || Buffer.from(arg, "utf8").toString("utf8") !== arg) throw new Error(DOCKER_COMMAND_ERROR);
    total += Buffer.byteLength(arg, "utf8");
    if (total > 262_144) throw new Error(DOCKER_COMMAND_ERROR);
  }
};
const decode = (chunks: readonly Buffer[]): string => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new Error(DOCKER_COMMAND_ERROR); }
};

export const executeDockerCommandCore = (
  spawnCommand: DockerCommandSpawn,
  file: string,
  args: readonly string[],
  rawOptions: DockerCommandCoreOptions
): Promise<DockerCommandCoreResult> => {
  validate(file, args, rawOptions);
  const options = rawOptions;
  if (options.signal?.aborted) return Promise.reject(new Error(DOCKER_COMMAND_ERROR));
  return new Promise((resolve, reject) => {
    let child: SpawnedDockerCommand;
    try { child = spawnCommand(file, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { reject(new Error(DOCKER_COMMAND_ERROR)); return; }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdin: Uint8Array | undefined = options.stdin;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let childClosed = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let stdinDone = false;
    let stdinClosed = false;
    let closeCode: number | null = null;
    let terminal: Error | undefined;
    let settled = false;
    let killed = false;
    let fallback: NodeJS.Timeout | undefined;
    const swallow = (): void => undefined;

    const clearBuffers = (): void => {
      stdoutChunks.splice(0);
      stderrChunks.splice(0);
      stdin = undefined;
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (fallback) clearTimeout(fallback);
      options.signal?.removeEventListener("abort", onAbort);
      child.off("error", onChildError);
      child.off("close", onChildClose);
      child.stdout.off("data", onStdoutData);
      child.stderr.off("data", onStderrData);
      child.stdout.off("error", onStreamError);
      child.stderr.off("error", onStreamError);
      child.stdin.off("error", onStreamError);
      child.stdout.off("close", onStdoutClose);
      child.stderr.off("close", onStderrClose);
      child.stdin.off("close", onStdinClose);
      clearBuffers();
    };
    const absorbUntilClose = (
      stream: Readable | Writable,
      alreadyClosed: boolean
    ): void => {
      if (alreadyClosed) return;
      const release = (): void => { stream.off("error", swallow); };
      stream.on("error", swallow);
      stream.once("close", release);
    };
    const absorbLateErrors = (): void => {
      if (!childClosed) {
        const release = (): void => { child.off("error", swallow); };
        child.on("error", swallow);
        child.once("close", release);
      }
      absorbUntilClose(child.stdout, stdoutClosed);
      absorbUntilClose(child.stderr, stderrClosed);
      absorbUntilClose(child.stdin, stdinClosed);
    };
    const settle = (
      error?: Error,
      result?: DockerCommandCoreResult,
      absorbLate = true
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (absorbLate) absorbLateErrors();
      if (error) reject(error); else resolve(result!);
    };
    const settleTerminated = (): void =>
      settle(terminal ?? new Error(DOCKER_COMMAND_ERROR), undefined, true);
    const requestTermination = (error: Error): void => {
      if (settled || terminal) return;
      terminal = error;
      if (!killed) {
        killed = true;
        try { child.kill("SIGKILL"); } catch { /* bounded fallback settles safely */ }
      }
      fallback = setTimeout(settleTerminated, FALLBACK_MS);
    };
    const maybeSettle = (): void => {
      if (settled) return;
      if (terminal) {
        if (childClosed) settleTerminated();
        return;
      }
      if (!childClosed || !stdoutClosed || !stderrClosed || !stdinDone) return;
      if (!Number.isInteger(closeCode) || closeCode === null || closeCode < 0) {
        settle(new Error(DOCKER_COMMAND_ERROR));
        return;
      }
      let stderr: string;
      let stdout: string | Uint8Array;
      try {
        stderr = decode(stderrChunks);
        stdout = options.binary
          ? Uint8Array.from(Buffer.concat(stdoutChunks))
          : decode(stdoutChunks);
      } catch {
        settle(new Error(DOCKER_COMMAND_ERROR));
        return;
      }
      if (closeCode !== 0) {
        settle(new DockerCommandFailure(closeCode, stderr));
        return;
      }
      settle(undefined, { stderr, stdout });
    };
    const append = (target: Buffer[], chunk: unknown, current: number, cap: number): number => {
      let value: Buffer;
      try { value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); }
      catch { requestTermination(new Error(DOCKER_COMMAND_ERROR)); return current; }
      const next = current + value.byteLength;
      if (next > cap) {
        requestTermination(new Error(DOCKER_COMMAND_ERROR));
        return next;
      }
      target.push(Buffer.from(value));
      return next;
    };
    function onStdoutData(chunk: unknown): void {
      stdoutBytes = append(
        stdoutChunks,
        chunk,
        stdoutBytes,
        options.stdoutCap ?? (options.binary ? DOCKER_BINARY_CAP : DOCKER_TEXT_CAP)
      );
    }
    function onStderrData(chunk: unknown): void {
      stderrBytes = append(stderrChunks, chunk, stderrBytes, DOCKER_TEXT_CAP);
    }
    function onChildError(): void { requestTermination(new Error(DOCKER_COMMAND_ERROR)); }
    function onStreamError(): void { requestTermination(new Error(DOCKER_COMMAND_ERROR)); }
    function onChildClose(code: number | null): void {
      childClosed = true; closeCode = code; maybeSettle();
    }
    function onStdoutClose(): void { stdoutClosed = true; maybeSettle(); }
    function onStderrClose(): void { stderrClosed = true; maybeSettle(); }
    function onStdinClose(): void { stdinClosed = true; }
    function onAbort(): void { requestTermination(new Error(DOCKER_COMMAND_ERROR)); }

    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.on("error", onChildError);
    child.on("close", onChildClose);
    child.stdout.on("error", onStreamError);
    child.stderr.on("error", onStreamError);
    child.stdin.on("error", onStreamError);
    child.stdout.on("close", onStdoutClose);
    child.stderr.on("close", onStderrClose);
    child.stdin.on("close", onStdinClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => requestTermination(new Error(DOCKER_COMMAND_ERROR)), options.timeout);
    if (options.signal?.aborted) requestTermination(new Error(DOCKER_COMMAND_ERROR));
    if (settled || terminal) return;

    try {
      const view = stdin
        ? Buffer.from(stdin.buffer, stdin.byteOffset, stdin.byteLength)
        : undefined;
      child.stdin.end(view, (error?: Error | null) => {
        if (error) {
          requestTermination(new Error(DOCKER_COMMAND_ERROR));
          return;
        }
        stdinDone = true;
        stdin = undefined;
        maybeSettle();
      });
    } catch {
      requestTermination(new Error(DOCKER_COMMAND_ERROR));
    }
  });
};
