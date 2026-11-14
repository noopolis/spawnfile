import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createSecretMaskStream, maskSecrets } from "../../../shared/index.js";

export const TRIAL_EVIDENCE_VERSION = "spawnfile.training.trial-evidence.v1";
export const TRIAL_EVIDENCE_MANIFEST = "evidence.json";
/** Declared bound on one captured stream. A capture that reaches it is cut there and says so; nothing is ever cut silently. */
export const TRIAL_EVIDENCE_STREAM_BOUND_BYTES = 2 * 1024 * 1024 * 1024;

/** One Docker CLI call whose output is read as it is produced, never buffered whole. */
export type TrialDockerStream = (args: readonly string[]) => { stdout: Readable; stderr: Readable; exit: Promise<number>; kill(): void };

export const createTrialDockerStream = (dockerCommand = "docker"): TrialDockerStream => (args) => {
  const child = spawn(dockerCommand, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  return { stdout: child.stdout, stderr: child.stderr, kill: () => { child.kill("SIGKILL"); },
    exit: new Promise((resolve) => { child.once("error", () => resolve(-1)); child.once("close", (code) => resolve(code ?? -1)); }) };
};

/** One file of a trial's evidence directory and how much of its source it holds. */
export interface TrialEvidenceCapture {
  /** Relative to the evidence directory. */
  file: string;
  source: string;
  bytes: number;
  /** True only when the whole source was written: it ended cleanly and under the bound. */
  complete: boolean;
  /** Present when the capture was cut at {@link TRIAL_EVIDENCE_STREAM_BOUND_BYTES}. */
  boundBytes?: number;
  error?: string;
}

/** An engine's own records of its turns, declared by its runtime relative to the agent's runtime home. */
export interface TrialEngineDiagnostics { agentId: string; home: string; paths: readonly string[] }

export interface TrialEvidenceInput {
  /** The trial's own evidence directory on the operator's disk; created if absent. */
  directory: string;
  container: string;
  /** Secret values this container was given; masked wherever they appear. */
  secrets: readonly string[];
  diagnostics?: readonly TrialEngineDiagnostics[];
  /** Absolute container paths of login files: a declared path at, above or below one is never collected. */
  loginPaths?: readonly string[];
  /** Short texts the trial layer itself read from the runtime, kept whole under their file names (secrets masked). */
  notes?: Readonly<Record<string, string>>;
  stream?: TrialDockerStream;
  boundBytes?: number;
}

export interface TrialEvidenceManifest {
  version: typeof TRIAL_EVIDENCE_VERSION;
  container: string;
  capturedAt: string;
  captures: TrialEvidenceCapture[];
  /** Declared engine paths that were not collected, and why. */
  refused: { source: string; reason: string }[];
}

export type TrialEvidenceCaptureCall = (input: TrialEvidenceInput) => Promise<TrialEvidenceManifest>;

const within = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent.replace(/\/+$/u, "")}/`);

/** Masked, bounded and written as it arrives; resolves with what reached the file. */
const writeStream = async (source: Readable, file: string, secrets: readonly string[], bound: number, stop: () => void): Promise<{ bytes: number; boundHit: boolean }> => {
  let bytes = 0;
  let boundHit = false;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (boundHit) return done();
      const room = bound - bytes;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      bytes += kept.length;
      if (chunk.length > room) { boundHit = true; stop(); }
      done(null, kept);
    }
  });
  await pipeline(source, createSecretMaskStream(secrets), limit, createWriteStream(file, { mode: 0o600 }));
  return { bytes, boundHit };
};

/**
 * Saves everything a trial container can still say before it is removed: its
 * whole stdout and stderr (every line Docker kept, timestamped, not a tail),
 * and each engine record its runtime declared, as one tar archive per declared
 * path. Streamed to the operator's disk through the Docker CLI (no bind mount),
 * secrets masked byte for byte. Never throws: a capture that could not be made
 * is recorded as such, and the manifest lists what the directory holds.
 */
export const captureTrialEvidence: TrialEvidenceCaptureCall = async (input) => {
  const stream = input.stream ?? createTrialDockerStream();
  const bound = input.boundBytes ?? TRIAL_EVIDENCE_STREAM_BOUND_BYTES;
  const manifest: TrialEvidenceManifest = { version: TRIAL_EVIDENCE_VERSION, container: input.container, capturedAt: new Date().toISOString(), captures: [], refused: [] };
  const capture = async (args: readonly string[], outputs: readonly { channel: "stdout" | "stderr"; file: string }[], source: string): Promise<void> => {
    const call = stream(args);
    let failure = "";
    if (!outputs.some((output) => output.channel === "stderr")) call.stderr.on("data", (chunk: Buffer) => { if (failure.length < 2_000) failure += chunk.toString("utf8"); });
    const written = await Promise.all(outputs.map(async (output) => {
      await mkdir(path.dirname(path.join(input.directory, output.file)), { recursive: true, mode: 0o700 });
      return writeStream(call[output.channel], path.join(input.directory, output.file), input.secrets, bound, call.kill)
        .then((result) => ({ ...result, error: undefined as string | undefined }), (error: unknown) => ({ bytes: 0, boundHit: false, error: error instanceof Error ? error.message : String(error) }));
    }));
    const code = await call.exit;
    written.forEach((result, index) => {
      const error = result.error ?? (result.boundHit || code === 0 ? undefined : `docker ${args[0]} exited ${code}${failure ? `: ${maskSecrets(failure, input.secrets).replace(/\s+/gu, " ").trim().slice(0, 400)}` : ""}`);
      manifest.captures.push({ file: outputs[index]!.file, source, bytes: result.bytes, complete: error === undefined && !result.boundHit,
        ...(result.boundHit ? { boundBytes: bound } : {}), ...(error === undefined ? {} : { error }) });
    });
  };
  try {
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    for (const [file, text] of Object.entries(input.notes ?? {})) {
      const bytes = Buffer.from(`${maskSecrets(text, input.secrets)}\n`, "utf8");
      await writeFile(path.join(input.directory, file), bytes, { mode: 0o600 });
      manifest.captures.push({ file, source: "runtime control", bytes: bytes.length, complete: true });
    }
    await capture(["logs", "--timestamps", input.container],
      [{ channel: "stdout", file: "container.stdout.log" }, { channel: "stderr", file: "container.stderr.log" }], "container log");
    for (const [index, agent] of (input.diagnostics ?? []).entries()) {
      for (const relative of agent.paths) {
        const source = path.posix.join(agent.home, relative);
        const login = (input.loginPaths ?? []).find((file) => within(source, file) || within(file, source));
        if (login !== undefined || !within(agent.home, source)) {
          manifest.refused.push({ source, reason: login === undefined ? "outside the agent's runtime home" : "holds a login file" });
          continue;
        }
        await capture(["cp", `${input.container}:${source}`, "-"],
          [{ channel: "stdout", file: `engine/${index}-${relative.replace(/[^A-Za-z0-9._-]+/gu, "_")}.tar` }], source);
      }
    }
  } catch (error) {
    manifest.captures.push({ file: "", source: "evidence directory", bytes: 0, complete: false, error: error instanceof Error ? error.message : String(error) });
  }
  await writeFile(path.join(input.directory, TRIAL_EVIDENCE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
  return manifest;
};
