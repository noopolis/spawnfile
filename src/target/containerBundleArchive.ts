import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const BLOCK = 512;
const MAX_BYTES = 4_194_304;

export interface ContainerBundleArchiveEntry { readonly bytes: Uint8Array; readonly path: string; }
export interface ParsedContainerBundleArchive { readonly bytes: Uint8Array; readonly entries: readonly ContainerBundleArchiveEntry[]; }
export interface ContainerBundleEnvelopeClaims {
  readonly artifact_digest: string;
  readonly build_policy_digest: string;
  readonly bundle_digest: string;
  readonly entrypoint: string;
  readonly launcher_digest: string;
  readonly network_alias: string;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly platform_digest: string;
}

const fail = (): never => { throw new Error("Container bundle archive failed"); };
const zero = (value: Uint8Array): boolean => value.every((byte) => byte === 0);
const text = (value: Uint8Array): string => {
  const nul = value.indexOf(0); const end = nul < 0 ? value.length : nul;
  if (nul >= 0 && !zero(value.subarray(nul))) return fail();
  const result = Buffer.from(value.subarray(0, end)).toString("utf8");
  if (!Buffer.from(result, "utf8").equals(Buffer.from(value.subarray(0, end)))) return fail();
  return result;
};

const rawSha = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const octal = (value: Uint8Array): number => {
  if (value.at(-1) !== 0 || value.subarray(0, -1).some((byte) => byte < 48 || byte > 55)) return fail();
  const parsed = Number.parseInt(Buffer.from(value.subarray(0, -1)).toString("ascii"), 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail(); return parsed;
};
const canonicalOctal = (value: Uint8Array): number => {
  const parsed = octal(value);
  if (!Buffer.from(`${parsed.toString(8).padStart(value.byteLength - 1, "0")}\0`, "ascii").equals(Buffer.from(value))) return fail();
  return parsed;
};
const checksum = (header: Uint8Array): number => {
  const field = header.subarray(148, 156);
  /* POSIX USTAR permits both its traditional six-digit NUL-space spelling
   * and a seven-digit NUL-terminated field. Accept neither padding nor any
   * other checksum representation. */
  const traditional = field[6] === 0 && field[7] === 0x20 && field.subarray(0, 6).every((byte) => byte >= 48 && byte <= 55);
  const nulTerminated = field[7] === 0 && field.subarray(0, 7).every((byte) => byte >= 48 && byte <= 55);
  if (!traditional && !nulTerminated) return fail();
  const claimed = Number.parseInt(Buffer.from(field.subarray(0, traditional ? 6 : 7)).toString("ascii"), 8);
  let actual = 0; for (let index = 0; index < BLOCK; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  if (claimed !== actual) return fail(); return claimed;
};
const safePath = (raw: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(raw) || raw.includes("//")
    || raw.split("/").some((part) => part === "." || part === "..")) return fail();
  return raw;
};
const canonicalPath = (name: string, prefix: string): string => {
  if (name.length === 0 || prefix.endsWith("/")) return fail();
  const joined = safePath(prefix ? `${prefix}/${name}` : name);
  if (joined.length <= 100) {
    if (prefix || name !== joined) return fail();
    return joined;
  }
  const split = joined.lastIndexOf("/");
  if (split < 1 || joined.slice(0, split) !== prefix || joined.slice(split + 1) !== name
    || Buffer.byteLength(prefix, "utf8") > 155 || Buffer.byteLength(name, "utf8") > 100) return fail();
  return joined;
};
const canonicalAllowed = (paths: readonly string[]): readonly string[] => {
  if (paths.length < 1 || paths.length > 32) return fail();
  const normalized = paths.map(safePath);
  if (normalized.some((value, index) => index > 0 && normalized[index - 1]! >= value)) return fail();
  return normalized;
};

/** Validates an uncompressed canonical USTAR bundle before Docker ever receives it. */
export const parseContainerBundleArchive = (
  raw: unknown,
  allowedPaths: readonly string[],
  expectedDigest: string
): ParsedContainerBundleArchive => {
  if (!(raw instanceof Uint8Array) || raw.byteLength < BLOCK * 2 || raw.byteLength > MAX_BYTES || raw.byteLength % BLOCK !== 0
    || !/^sha256:[a-f0-9]{64}$/u.test(expectedDigest)
    || `sha256:${createHash("sha256").update(raw).digest("hex")}` !== expectedDigest) return fail();
  const expected = canonicalAllowed(allowedPaths);
  const entries: ContainerBundleArchiveEntry[] = [];
  let offset = 0;
  while (offset < raw.byteLength) {
    const header = raw.subarray(offset, offset + BLOCK); offset += BLOCK;
    if (zero(header)) {
      if (entries.length === 0 || offset + BLOCK !== raw.byteLength || !zero(raw.subarray(offset, offset + BLOCK))) return fail();
      if (entries.length !== expected.length) return fail();
      return Object.freeze({ bytes: new Uint8Array(raw), entries: Object.freeze(entries) });
    }
    if (!Buffer.from(header.subarray(257, 263)).equals(Buffer.from("ustar\0", "ascii"))
      || !Buffer.from(header.subarray(263, 265)).equals(Buffer.from("00", "ascii"))
      || !zero(header.subarray(157, 257)) || !zero(header.subarray(500, 512))) return fail();
    checksum(header);
    if (canonicalOctal(header.subarray(100, 108)) !== 0o644 || canonicalOctal(header.subarray(108, 116)) !== 0
      || canonicalOctal(header.subarray(116, 124)) !== 0 || canonicalOctal(header.subarray(136, 148)) !== 0
      || !zero(header.subarray(329, 345)) || header[156] !== 48
      || text(header.subarray(265, 297)) !== "" || text(header.subarray(297, 329)) !== "") return fail();
    const name = text(header.subarray(0, 100)); const prefix = text(header.subarray(345, 500));
    const path = canonicalPath(name, prefix);
    if (path !== expected[entries.length]) return fail();
    const size = canonicalOctal(header.subarray(124, 136)); const end = offset + size; const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (end > raw.byteLength || offset + padded > raw.byteLength || !zero(raw.subarray(end, offset + padded))) return fail();
    entries.push(Object.freeze({ bytes: new Uint8Array(raw.subarray(offset, end)), path })); offset += padded;
  }
  return fail();
};

/**
 * The versioned preparation request is the sealed deployment envelope.
 * The archive digest already commits every byte. The artifact digest is an
 * owner-defined semantic identity (for example, a manifest digest), while the
 * launcher is the one generic executable role whose raw bytes Spawnfile can
 * and must verify without interpreting provider-private contents.
 */
export const validateContainerBundleEnvelope = (archive: ParsedContainerBundleArchive, claims: ContainerBundleEnvelopeClaims): void => {
  try {
    const launcher = archive.entries.find((item) => item.path === claims.entrypoint);
    if (!launcher || rawSha(launcher.bytes) !== claims.launcher_digest
      || !/^sha256:[a-f0-9]{64}$/u.test(claims.artifact_digest)
      || claims.artifact_digest === claims.launcher_digest) return fail();
  } catch { return fail(); }
};
