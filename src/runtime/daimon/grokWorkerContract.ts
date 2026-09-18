import { createHash } from "node:crypto";
import path from "node:path";

import { SpawnfileError } from "../../shared/index.js";

import {
  DAIMON_GROK_ENGINE_BROKER,
  type DaimonGrokBrokerModel,
  type DaimonGrokBrokerReasoningEffort
} from "./contractManifest.js";
import { DAIMON_GROK_WORKER_CONFIG_BYTES } from "./grokWorkerConfigBytes.js";

export const DAIMON_GROK_WORKER_SANDBOX_PROFILE = "daimon-strict" as const;
export const DAIMON_GROK_WORKER_HOME_DIRECTORY = ".grok" as const;

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

/** Characters TOML or Grok would reinterpret inside a deny entry (mirrors Daimon's refusal set). */
const UNSAFE_DENY_PATH_CHARACTER = new RegExp("[\"\\\\\\u0000-\\u001f\\u007f*?[\\]]", "u");

/**
 * The worker `config.toml` bytes for one declared model x effort: Daimon's own
 * renderer output (vendored by `scripts/vendor-daimon-grok-contract.ts`),
 * refused unless it hashes to the manifest pin the broker attests every turn.
 */
export const resolveDaimonGrokWorkerConfig = (
  model: DaimonGrokBrokerModel,
  reasoningEffort: DaimonGrokBrokerReasoningEffort,
  vendored: Readonly<Record<string, Readonly<Record<string, string>>>> = DAIMON_GROK_WORKER_CONFIG_BYTES
): { bytes: string; sha256: string } => {
  const pins = DAIMON_GROK_ENGINE_BROKER.worker.configSha256 as Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
  const pin = pins[model]?.[reasoningEffort];
  const bytes = vendored[model]?.[reasoningEffort];
  if (pin === undefined || bytes === undefined || sha256(bytes) !== pin) {
    throw new SpawnfileError(
      "compile_error",
      `Vendored Daimon Grok worker config for ${model}/${reasoningEffort} does not match the contract manifest pin; re-vendor the Daimon contract`
    );
  }
  return { bytes, sha256: pin };
};

/**
 * Byte mirror of Daimon's `renderGrokWorkerSandboxProfile`
 * (`daimon/src/runtime/grokWorkerSandboxProfile.ts`), pinned to Daimon's own
 * output by `DAIMON_GROK_WORKER_PROFILE_SAMPLES`. Grok 1.0.34 runs every profile
 * inside bubblewrap and enforces a non-empty `deny` list; its strict base still
 * reads all of `/run`, `/var`, `/tmp` and `/etc`, so this list is what keeps
 * protected paths from the worker.
 */
export const renderDaimonGrokWorkerSandboxProfile = (denyPaths: readonly string[]): string => {
  const denied = [...new Set(denyPaths)].sort();
  for (const entry of denied) {
    if (!path.posix.isAbsolute(entry) || path.posix.normalize(entry) !== entry || entry === "/" || entry.endsWith("/") || UNSAFE_DENY_PATH_CHARACTER.test(entry)) {
      throw new SpawnfileError("compile_error", `Invalid Grok worker sandbox deny path: ${JSON.stringify(entry)}`);
    }
  }
  return [
    `[profiles.${DAIMON_GROK_WORKER_SANDBOX_PROFILE}]`,
    'extends = "strict"',
    "restrict_network = true",
    `deny = [${denied.map((entry) => JSON.stringify(entry)).join(", ")}]`,
    ""
  ].join("\n");
};

export const daimonGrokWorkerSandboxProfileSha256 = (denyPaths: readonly string[]): string =>
  sha256(renderDaimonGrokWorkerSandboxProfile(denyPaths));
