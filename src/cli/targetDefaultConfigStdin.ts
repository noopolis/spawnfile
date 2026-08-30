import { TextDecoder } from "node:util";

import type {
  TargetDefaultConfig,
  TargetDefaultConfigInputs,
  TargetDefaultWorldReadinessConfig
} from "./targetDefaultConfig.js";

export const TARGET_DEFAULT_CONFIG_STDIN_ERROR = "Invalid target configuration";
export const TARGET_DEFAULT_CONFIG_STDIN_VERSION = "spawnfile.target-default-config.v1";
export const TARGET_LOOKUP_CONFIG_STDIN_VERSION = "spawnfile.target-lookup-config.v1";
export const MAX_TARGET_DEFAULT_CONFIG_STDIN_BYTES = 262_144;
const TARGET_CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export interface TargetLookupConfig {
  readonly context: string;
}

const fail = (): never => { throw new TypeError(TARGET_DEFAULT_CONFIG_STDIN_ERROR); };

const assertNoDuplicateJsonKeys = (source: string): void => {
  let offset = 0;
  const whitespace = (): void => { while (/\s/u.test(source[offset] ?? "")) offset += 1; };
  const string = (): string => {
    const start = offset; offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") offset += 2;
      else if (source[offset] === "\"") {
        offset += 1;
        return JSON.parse(source.slice(start, offset)) as string;
      } else offset += 1;
    }
    return fail();
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") return object();
    if (source[offset] === "[") return array();
    if (source[offset] === "\"") { string(); return; }
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset] ?? "")) offset += 1;
  };
  const object = (): void => {
    offset += 1; whitespace();
    const keys = new Set<string>();
    if (source[offset] === "}") { offset += 1; return; }
    while (offset < source.length) {
      const key = string();
      if (keys.has(key)) return fail();
      keys.add(key); whitespace(); offset += 1; value(); whitespace();
      if (source[offset] === "}") { offset += 1; return; }
      offset += 1; whitespace();
    }
    return fail();
  };
  const array = (): void => {
    offset += 1; whitespace();
    if (source[offset] === "]") { offset += 1; return; }
    while (offset < source.length) {
      value(); whitespace();
      if (source[offset] === "]") { offset += 1; return; }
      offset += 1; whitespace();
    }
    return fail();
  };
  value(); whitespace();
  if (offset !== source.length) fail();
};

const exactDefaultConfigObject = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const expected = [
    "artifactMappings", "container_bundle_store_root", "context", "dockerCommand", "evidenceDestination", "evidenceHelperBaseImage", "preparedEvidenceHelper",
    "helperArtifactManifestDigest", "preparedArtifactMappings", "timeoutMs", "version"
  ];
  const required = ["context", "dockerCommand", "evidenceDestination", "timeoutMs", "version"];
  const keys = Object.keys(raw);
  if (keys.some((key) => !expected.includes(key))
    || required.some((key) => !keys.includes(key))) return fail();
  const value = raw as Record<string, unknown>;
  if (value.version !== TARGET_DEFAULT_CONFIG_STDIN_VERSION
    || Object.hasOwn(value, "artifactMappings") !== Object.hasOwn(value, "helperArtifactManifestDigest")) return fail();
  return value;
};

const exactLookupConfigObject = (raw: unknown): TargetLookupConfig => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes("context") || !keys.includes("version")) return fail();
  const value = raw as Record<string, unknown>;
  if (value.version !== TARGET_LOOKUP_CONFIG_STDIN_VERSION
    || typeof value.context !== "string"
    || !TARGET_CONTEXT_PATTERN.test(value.context)) return fail();
  return Object.freeze({ context: value.context });
};

const readBytes = async (input: AsyncIterable<unknown>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (!input || typeof input[Symbol.asyncIterator] !== "function") return fail();
    for await (const raw of input) {
      const chunk = typeof raw === "string" ? new TextEncoder().encode(raw)
        : raw instanceof Uint8Array ? Uint8Array.from(raw) : fail();
      // A non-empty chunk consumes at least one byte, so the byte ceiling also
      // bounds iteration.  Rejecting empty chunks prevents an unbounded stream
      // from evading that ceiling forever.
      if (chunk.byteLength === 0) return fail();
      if (chunk.byteLength > MAX_TARGET_DEFAULT_CONFIG_STDIN_BYTES - total) return fail();
      chunks.push(chunk); total += chunk.byteLength;
    }
    if (total === 0) return fail();
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch { return fail(); }
};

const readRawConfigStdin = async (
  input: AsyncIterable<unknown>
): Promise<unknown> => {
  const bytes = await readBytes(input);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail(); }
  if (source.startsWith("\uFEFF")) return fail();
  try {
    assertNoDuplicateJsonKeys(source);
    return JSON.parse(source) as unknown;
  } catch { return fail(); }
};

export const readTargetDefaultConfigStdin = async (
  input: AsyncIterable<unknown>
): Promise<TargetDefaultConfig> => {
  const raw = exactDefaultConfigObject(await readRawConfigStdin(input));
  const inputs = defaultConfigInputs(raw);
  try {
    const { loadTargetDefaultConfig } = await import("./targetDefaultConfig.js");
    return await loadTargetDefaultConfig(inputs);
  }
  catch { return fail(); }
};

const defaultConfigInputs = (
  raw: Record<string, unknown>
): TargetDefaultConfigInputs => ({
  ...(Object.hasOwn(raw, "artifactMappings") ? {
    artifactMappings: raw.artifactMappings as TargetDefaultConfigInputs["artifactMappings"]
  } : {}),
  ...(Object.hasOwn(raw, "container_bundle_store_root") ? {
    containerBundleStoreRoot: raw.container_bundle_store_root as string
  } : {}),
  context: raw.context as string,
  dockerCommand: raw.dockerCommand as string,
  evidenceDestination: raw.evidenceDestination as string,
  ...(Object.hasOwn(raw, "evidenceHelperBaseImage") ? {
    evidenceHelperBaseImage: raw.evidenceHelperBaseImage as string
  } : {}),
  ...(Object.hasOwn(raw, "preparedEvidenceHelper") ? {
    preparedEvidenceHelper: raw.preparedEvidenceHelper as TargetDefaultConfigInputs["preparedEvidenceHelper"]
  } : {}),
  ...(Object.hasOwn(raw, "helperArtifactManifestDigest") ? {
    helperArtifactManifestDigest: raw.helperArtifactManifestDigest as string
  } : {}),
  preparedArtifactMappings: raw.preparedArtifactMappings as TargetDefaultConfigInputs["preparedArtifactMappings"],
  timeoutMs: raw.timeoutMs as number
});

/** Parses the normal config envelope but resolves only the read-only readiness path. */
export const readTargetWorldReadinessConfigStdin = async (
  input: AsyncIterable<unknown>
): Promise<TargetDefaultWorldReadinessConfig> => {
  const raw = exactDefaultConfigObject(await readRawConfigStdin(input));
  const inputs = defaultConfigInputs(raw);
  try {
    const { resolveTargetDefaultWorldReadinessConfig } = await import(
      "./targetDefaultConfig.js"
    );
    return resolveTargetDefaultWorldReadinessConfig(inputs);
  }
  catch { return fail(); }
};

/** Parses only the read-only lookup authority; it performs no filesystem work. */
export const readTargetLookupConfigStdin = async (
  input: AsyncIterable<unknown>
): Promise<TargetLookupConfig> =>
  exactLookupConfigObject(await readRawConfigStdin(input));
