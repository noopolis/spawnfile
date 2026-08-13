import { constants } from "node:fs";
import { lstat, mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { SpawnfileError } from "../shared/index.js";
import type { SelectedTargetReceipt } from "./contracts.js";
import type { DockerResourceExecutor } from "./dockerResourcesProvider.js";
import { selectedTargetForContextEndpoint } from "./dockerTargetBinding.js";

const ERROR = "Docker context snapshot failed";
const MAX_INSPECTION_BYTES = 32_768;
const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const TLS_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
type SnapshotRemove = typeof rm;
let snapshotRemove: SnapshotRemove = rm;

/** Test-only seam for deterministic cleanup failure coverage. */
export const setDockerContextSnapshotRemoveForTests = (
  replacement: SnapshotRemove
): (() => void) => {
  const previous = snapshotRemove;
  snapshotRemove = replacement;
  return () => { snapshotRemove = previous; };
};

const fail = (): never => { throw new SpawnfileError("runtime_error", ERROR); };
const exactRecord = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
  && Object.getPrototypeOf(raw) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};
const bounded = (value: unknown): value is string => typeof value === "string"
  && Buffer.byteLength(value, "utf8") <= MAX_INSPECTION_BYTES;

interface ContextSource {
  readonly endpoint: { readonly Host: string; readonly SkipTLSVerify: boolean };
  readonly tlsFiles: readonly string[];
  readonly tlsPath: string | null;
}

const parseContextInspection = (stdout: string, context: string): ContextSource => {
  if (!bounded(stdout)) return fail();
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return fail(); }
  if (!Array.isArray(raw) || raw.length !== 1 || !exactRecord(raw[0])) return fail();
  const value = raw[0];
  if (!exactKeys(value, ["Endpoints", "Metadata", "Name", "Storage", "TLSMaterial"])
    || value.Name !== context || !exactRecord(value.Endpoints) || !exactRecord(value.Metadata)
    || !exactRecord(value.Storage) || !exactRecord(value.TLSMaterial)
    || !exactKeys(value.Endpoints, ["docker"])
    || !(exactKeys(value.TLSMaterial, []) || exactKeys(value.TLSMaterial, ["docker"]))
    || !exactKeys(value.Storage, ["MetadataPath", "TLSPath"])) return fail();
  const endpoint = value.Endpoints.docker;
  const tlsFiles = value.TLSMaterial.docker ?? [];
  if (!exactRecord(endpoint) || !exactKeys(endpoint, ["Host", "SkipTLSVerify"])
    || typeof endpoint.Host !== "string" || typeof endpoint.SkipTLSVerify !== "boolean"
    || !Array.isArray(tlsFiles) || tlsFiles.length > 8
    || new Set(tlsFiles).size !== tlsFiles.length
    || tlsFiles.some((item) => typeof item !== "string" || !TLS_FILE_PATTERN.test(item))) return fail();
  const exactEndpoint = Object.freeze({ Host: endpoint.Host as string, SkipTLSVerify: endpoint.SkipTLSVerify as boolean });
  const tlsPath = value.Storage.TLSPath;
  if (tlsFiles.length === 0) return Object.freeze({ endpoint: exactEndpoint, tlsFiles: Object.freeze([]), tlsPath: null });
  if (typeof tlsPath !== "string" || tlsPath.length === 0 || Buffer.byteLength(tlsPath, "utf8") > 4_096) return fail();
  return Object.freeze({ endpoint: exactEndpoint, tlsFiles: Object.freeze([...tlsFiles] as string[]), tlsPath });
};

const copyStableTlsFile = async (source: string, destination: string): Promise<void> => {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size > 65_536) return fail();
    const bytes = await handle.readFile();
    const current = await handle.stat();
    if (!current.isFile() || current.size !== initial.size || bytes.length !== initial.size) return fail();
    await writeFile(destination, bytes, { encoding: undefined, flag: "wx", mode: 0o600 });
  } catch { return fail(); } finally { await handle?.close().catch(() => undefined); }
};

const requirePrivateDirectory = async (directory: string): Promise<void> => {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return fail();
  } catch { return fail(); }
};

const removeSnapshotRoot = async (root: string): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await snapshotRemove(root, { force: true, recursive: true });
      return;
    } catch {
      if (attempt === 2) return fail();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
};

export interface DockerContextSnapshot {
  readonly args: readonly ["--config", string, "--context", string];
  dispose(): Promise<void>;
}

/**
 * Privately recreates one named Docker context without placing its endpoint or
 * TLS options in argv. The synthetic config is short-lived and never exported.
 */
export const createDockerContextSnapshot = async (input: {
  readonly context: string;
  readonly executor: DockerResourceExecutor;
  readonly selectedTarget: Pick<SelectedTargetReceipt, "fingerprint" | "handle">;
  readonly timeoutMs: number;
}): Promise<DockerContextSnapshot> => {
  if (!CONTEXT_PATTERN.test(input.context) || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 1 || input.timeoutMs > 120_000) return fail();
  let root: string | undefined;
  try {
    const result = await input.executor("docker", ["context", "inspect", input.context], { timeout: input.timeoutMs });
    if (!result || result.stderr !== "" || !bounded(result.stdout)) return fail();
    const source = parseContextInspection(result.stdout, input.context);
    const selected = selectedTargetForContextEndpoint(input.context, source.endpoint.Host);
    if (selected.fingerprint !== input.selectedTarget.fingerprint || selected.handle !== input.selectedTarget.handle) return fail();
    root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-docker-context-"));
    const synthetic = `spfn_${randomUUID().replaceAll("-", "")}`;
    const contextId = createHash("sha256").update(synthetic, "utf8").digest("hex");
    const metaDirectory = path.join(root, "contexts", "meta", contextId);
    const tlsDirectory = path.join(root, "contexts", "tls", contextId, "docker");
    await mkdir(metaDirectory, { recursive: true, mode: 0o700 });
    await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
    const meta = JSON.stringify({ Endpoints: { docker: source.endpoint }, Metadata: {}, Name: synthetic });
    await writeFile(path.join(metaDirectory, "meta.json"), meta, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (source.tlsPath) {
      await requirePrivateDirectory(source.tlsPath);
      await requirePrivateDirectory(path.join(source.tlsPath, "docker"));
      for (const file of source.tlsFiles) {
        await copyStableTlsFile(path.join(source.tlsPath, "docker", file), path.join(tlsDirectory, file));
      }
    }
    const args = Object.freeze(["--config", root, "--context", synthetic] as const);
    let disposed = false;
    return Object.freeze({
      args,
      dispose: async (): Promise<void> => {
        if (disposed) return;
        await removeSnapshotRoot(root!);
        disposed = true;
      }
    });
  } catch {
    if (root) await removeSnapshotRoot(root);
    return fail();
  }
};
