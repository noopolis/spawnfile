import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { types as nodeTypes } from "node:util";

import { parseOpaqueTargetHandle, type OpaqueTargetHandle } from "../target/contracts.js";

export const PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION =
  "spawnfile.target-evidence-export-helper.prepared.v1" as const;
export const PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION =
  "spawnfile.target-evidence-export-helper.private.v3" as const;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HANDLE = /^opaque_[a-f0-9]{64}$/u;
const CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/u;
const ERROR = "Prepared evidence-export helper failed";
const OWNER = process.getuid?.();

export interface PreparedEvidenceHelperReceipt {
  readonly digest: `sha256:${string}`;
  readonly handle: OpaqueTargetHandle;
  readonly version: typeof PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION;
}
export interface PreparedEvidenceHelperPendingRecord {
  readonly base_config_digest: `sha256:${string}`;
  readonly base_image: string;
  readonly context: string;
  readonly daemon_digest: `sha256:${string}`;
  readonly endpoint_digest: `sha256:${string}`;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly recipe_digest: `sha256:${string}`;
  readonly version: typeof PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION;
}
export interface PreparedEvidenceHelperCompletionRecord {
  readonly accepted_image_config_digest: `sha256:${string}`;
  readonly pending_digest: `sha256:${string}`;
  readonly receipt: PreparedEvidenceHelperReceipt;
  readonly version: typeof PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION;
}
export interface PreparedEvidenceHelperAuthority {
  readonly completion: PreparedEvidenceHelperCompletionRecord | null;
  readonly pending: PreparedEvidenceHelperPendingRecord;
}

const fail = (): never => { throw new Error(ERROR); };
const hash = (domain: string, value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(`spawnfile.evidence-helper.${domain}.v1\0`).update(value).digest("hex")}`;
const exact = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
  && !nodeTypes.isProxy(raw) && Object.getPrototypeOf(raw) === Object.prototype
  && Reflect.ownKeys(raw).every((key) => typeof key === "string")
  && Object.keys(raw).sort().join("\0") === [...keys].sort().join("\0")
  && Object.values(Object.getOwnPropertyDescriptors(raw)).every((item) =>
    item.enumerable && "value" in item);
const digest = (raw: unknown): `sha256:${string}` =>
  typeof raw === "string" && DIGEST.test(raw) ? raw as `sha256:${string}` : fail();
const text = (raw: unknown, maximum: number): string =>
  typeof raw === "string" && raw === raw.trim() && !raw.includes("\0")
  && Buffer.byteLength(raw, "utf8") > 0 && Buffer.byteLength(raw, "utf8") <= maximum ? raw : fail();

export const parsePreparedEvidenceHelperReceipt = (raw: unknown): PreparedEvidenceHelperReceipt => {
  if (!exact(raw, ["digest", "handle", "version"])
    || raw.version !== PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION
    || typeof raw.handle !== "string" || !HANDLE.test(raw.handle)) return fail();
  return Object.freeze({ digest: digest(raw.digest), handle: parseOpaqueTargetHandle(raw.handle),
    version: PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION });
};
export const createPreparedEvidenceHelperReceiptBytes = (raw: unknown): string =>
  JSON.stringify(parsePreparedEvidenceHelperReceipt(raw));
export const pendingDigest = (raw: unknown): `sha256:${string}` =>
  hash("pending", createPreparedEvidenceHelperPendingBytes(raw));
export const createPreparedEvidenceHelperReceipt = (input: {
  readonly configDigest: unknown; readonly pendingDigest: unknown;
}): PreparedEvidenceHelperReceipt => {
  const config = digest(input.configDigest); const pending = digest(input.pendingDigest);
  const handle = parseOpaqueTargetHandle(`opaque_${hash("prepared-handle", `${pending}\0${config}`).slice(7)}`);
  return Object.freeze({ digest: hash("prepared-receipt", `${PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION}\0${handle}\0${pending}\0${config}`),
    handle, version: PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION });
};

export const parsePreparedEvidenceHelperPendingRecord = (
  raw: unknown,
): PreparedEvidenceHelperPendingRecord => {
  if (!exact(raw, ["base_config_digest", "base_image", "context", "daemon_digest", "endpoint_digest",
    "platform", "recipe_digest", "version"])
    || raw.version !== PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION
    || !exact(raw.platform, ["architecture", "os"])
    || raw.platform.os !== "linux"
    || raw.platform.architecture !== "amd64" && raw.platform.architecture !== "arm64") return fail();
  const context = text(raw.context, 64);
  if (!CONTEXT.test(context)) return fail();
  return Object.freeze({ base_config_digest: digest(raw.base_config_digest), base_image: text(raw.base_image, 512),
    context, daemon_digest: digest(raw.daemon_digest), endpoint_digest: digest(raw.endpoint_digest),
    platform: Object.freeze({ architecture: raw.platform.architecture, os: "linux" as const }),
    recipe_digest: digest(raw.recipe_digest),
    version: PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION });
};
export const createPreparedEvidenceHelperPendingBytes = (raw: unknown): string =>
  JSON.stringify(parsePreparedEvidenceHelperPendingRecord(raw));
export const parsePreparedEvidenceHelperCompletionRecord = (raw: unknown): PreparedEvidenceHelperCompletionRecord => {
  if (!exact(raw, ["accepted_image_config_digest", "pending_digest", "receipt", "version"])
    || raw.version !== PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION) return fail();
  const accepted = digest(raw.accepted_image_config_digest); const pending = digest(raw.pending_digest);
  const receipt = parsePreparedEvidenceHelperReceipt(raw.receipt);
  const expected = createPreparedEvidenceHelperReceipt({ configDigest: accepted, pendingDigest: pending });
  if (receipt.handle !== expected.handle || receipt.digest !== expected.digest) return fail();
  return Object.freeze({ accepted_image_config_digest: accepted, pending_digest: pending, receipt,
    version: PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION });
};
export const createPreparedEvidenceHelperCompletionBytes = (raw: unknown): string =>
  JSON.stringify(parsePreparedEvidenceHelperCompletionRecord(raw));
export const createPreparedEvidenceHelperKey = (input: {
  readonly baseConfigDigest: string; readonly context: string; readonly daemonDigest: string;
  readonly endpointDigest: string; readonly platform: { readonly architecture: string; readonly os: string };
  readonly recipeDigest: string;
}): string => hash("private-record", [input.context, input.endpointDigest, input.daemonDigest,
  input.platform.os, input.platform.architecture, input.baseConfigDigest, input.recipeDigest].join("\0")).slice(7);
export const newPreparedEvidenceHelperPendingRecord = (input: Omit<PreparedEvidenceHelperPendingRecord,
  "version">): PreparedEvidenceHelperPendingRecord =>
  parsePreparedEvidenceHelperPendingRecord({ ...input, version: PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION });
export const newPreparedEvidenceHelperCompletionRecord = (pending: unknown, configDigest: unknown): PreparedEvidenceHelperCompletionRecord => {
  const pendingRecord = parsePreparedEvidenceHelperPendingRecord(pending); const pendingHash = pendingDigest(pendingRecord);
  const accepted = digest(configDigest);
  return parsePreparedEvidenceHelperCompletionRecord({ accepted_image_config_digest: accepted, pending_digest: pendingHash,
    receipt: createPreparedEvidenceHelperReceipt({ configDigest: accepted, pendingDigest: pendingHash }),
    version: PREPARED_EVIDENCE_HELPER_PRIVATE_VERSION });
};

const root = async (raw: unknown): Promise<string> => {
  if (typeof raw !== "string" || !path.isAbsolute(raw) || path.normalize(raw) !== raw
    || raw === path.parse(raw).root) return fail();
  let existed = true;
  try { await lstat(raw); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
    existed = false;
  }
  try { await mkdir(raw, { mode: 0o700, recursive: true }); } catch { return fail(); }
  const info = await lstat(raw).catch(fail);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
    || OWNER !== undefined && info.uid !== OWNER || await realpath(raw).catch(fail) !== raw) return fail();
  await syncRoot(raw);
  if (!existed) await syncRoot(path.dirname(raw));
  return raw;
};
const readFile = async (file: string, links: readonly number[] = [1]): Promise<string | null> => {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !links.includes(info.nlink) || info.size < 1 || info.size > 16_384
      || (info.mode & 0o777) !== 0o600 || OWNER !== undefined && info.uid !== OWNER) return fail();
    return await handle.readFile({ encoding: "utf8" });
  } catch { return fail(); } finally { await handle?.close().catch(() => undefined); }
};
const syncRoot = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(fail);
  try { await handle.sync(); } finally { await handle.close().catch(() => undefined); }
};

/** Immutable, fsynced pending/completion authority records keyed by exact target facts. */
export class PreparedEvidenceHelperAuthorityStore {
  readonly #root: string;
  public constructor(privateRoot: string) { this.#root = privateRoot; }
  public async load(key: string): Promise<PreparedEvidenceHelperAuthority | null> {
    const pending = await this.#read(key, "pending", parsePreparedEvidenceHelperPendingRecord);
    if (!pending) return null;
    // A writer fsyncs before and after publication.  A racing reader may observe
    // the link before that writer reaches its directory fsync, so it must make
    // the accepted transaction durable before proceeding to a Docker mutation.
    await syncRoot(this.#root);
    const completion = await this.#read(key, "complete", parsePreparedEvidenceHelperCompletionRecord);
    if (completion) await syncRoot(this.#root);
    if (completion && completion.pending_digest !== pendingDigest(pending)) return fail();
    return Object.freeze({ completion, pending });
  }
  public async reserve(key: string, raw: unknown): Promise<PreparedEvidenceHelperPendingRecord> {
    const record = parsePreparedEvidenceHelperPendingRecord(raw);
    return this.#publish(key, "pending", record, createPreparedEvidenceHelperPendingBytes,
      parsePreparedEvidenceHelperPendingRecord);
  }
  public async complete(key: string, raw: unknown): Promise<PreparedEvidenceHelperCompletionRecord> {
    const pending = await this.#read(key, "pending", parsePreparedEvidenceHelperPendingRecord);
    if (!pending) return fail();
    const record = parsePreparedEvidenceHelperCompletionRecord(raw);
    if (record.pending_digest !== pendingDigest(pending)) return fail();
    return this.#publish(key, "complete", record, createPreparedEvidenceHelperCompletionBytes,
      parsePreparedEvidenceHelperCompletionRecord);
  }
  async #read<T>(key: string, phase: "pending" | "complete", parser: (raw: unknown) => T): Promise<T | null> {
    if (!/^[a-f0-9]{64}$/u.test(key)) return fail();
    const file = path.join(this.#root, `${key}.${phase}.json`);
    const complete = await readFile(file, [1, 2]); if (complete === null) return null;
    try { return parser(JSON.parse(complete)); } catch { return fail(); }
  }
  async #publish<T>(key: string, phase: "pending" | "complete", raw: T,
    bytesFor: (value: unknown) => string, parser: (value: unknown) => T): Promise<T> {
    if (!/^[a-f0-9]{64}$/u.test(key)) return fail();
    const bytes = bytesFor(raw); const existing = await this.#read(key, phase, parser);
    if (existing) {
      await syncRoot(this.#root);
      return bytesFor(existing) === bytes ? existing : fail();
    }
    const file = path.join(this.#root, `${key}.${phase}.json`);
    const stage = path.join(this.#root, `.${key}.${phase}.${randomBytes(12).toString("hex")}.stage`);
    let handle;
    try {
      handle = await open(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
      await syncRoot(this.#root); await link(stage, file); await syncRoot(this.#root);
      await unlink(stage); await syncRoot(this.#root);
    } catch {
      await handle?.close().catch(() => undefined);
      const published = await this.#read(key, phase, parser);
      if (!published || bytesFor(published) !== bytes) return fail();
      await syncRoot(this.#root);
    } finally { await unlink(stage).catch(() => undefined); }
    return (await this.#read(key, phase, parser)) ?? fail();
  }
}
export const initializePreparedEvidenceHelperAuthorityStore = async (
  privateRoot: unknown,
): Promise<PreparedEvidenceHelperAuthorityStore> =>
  new PreparedEvidenceHelperAuthorityStore(await root(privateRoot));
