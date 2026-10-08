import { createHash } from "node:crypto";

import type { BundleFilesInput, BundleIdentityMode } from "./workspaceBundleFiles.js";
import { WORKSPACE_BUNDLE_TAR_WRITER, type BundleTarSummary } from "./workspaceBundleTar.js";

const KEY_VERSION = "spawnfile.workspace-bundle-key.v1";

export type BundleInputKind = "dependencies" | "files" | "generated";

/** Everything a build step needs that is not part of one bundle's declaration. */
export interface BundleBuildContext {
  dockerCommand: string;
  identity: BundleIdentityMode;
  /** Real path of this compile's output directory, excluded from every input root that contains it. */
  outputReal: string;
  /** `linux/<arch>` of the target container. */
  platform: string;
  /** Private scratch space for installs and generated output. */
  workRoot: string;
}

/** A bundle whose key is known; `write` builds its archive only on a cache miss. */
export interface BundleBuildPlan {
  input: BundleInputKind;
  key: string;
  write: (temporaryTar: string) => Promise<BundleTarSummary>;
}

/** The identity of a file input set: every entry's path, mode and content identity. */
export const filesIdentity = (input: Pick<BundleFilesInput, "entries">): Array<[string, number, string]> =>
  input.entries.map((entry) => [entry.path, entry.mode, entry.identity]);

/**
 * The cache key of a `files` bundle: every input file's path, mode and
 * content identity, the archive writer that turns them into bytes, and the
 * target platform.
 */
export const computeWorkspaceBundleKey = (input: Pick<BundleFilesInput, "entries">, platform: string): string =>
  createHash("sha256").update(JSON.stringify({ entries: filesIdentity(input), input: "files", platform, version: KEY_VERSION, writer: WORKSPACE_BUNDLE_TAR_WRITER })).digest("hex");

/**
 * The cache key of a recipe bundle: its kind, the full recipe (input
 * identities, commands, pinned images, captured tool versions), the archive
 * writer and the target platform. Callers build `recipe` with a fixed key order.
 */
export const computeRecipeBundleKey = (input: Exclude<BundleInputKind, "files">, recipe: unknown, platform: string): string =>
  createHash("sha256").update(JSON.stringify({ input, platform, recipe, version: KEY_VERSION, writer: WORKSPACE_BUNDLE_TAR_WRITER })).digest("hex");
