import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { resolveSpawnfileHome } from "../auth/paths.js";
import { writeDurableFile } from "../filesystem/durableWrite.js";
import { SpawnfileError } from "../shared/index.js";
import type { DeclaredProjectAdapters } from "./declarations.js";

type AdapterEntries = DeclaredProjectAdapters["adapters"];

const TRUST_SEGMENTS = ["trust", "runtime-adapters"] as const;

const trustRecordSchema = z.object({
  adapters: z.array(z.tuple([z.string(), z.string()])),
  manifestPath: z.string(),
  version: z.literal(1)
}).strict();

type TrustRecord = z.infer<typeof trustRecordSchema>;

const recordName = (manifestPath: string): string =>
  `${createHash("sha256").update(manifestPath, "utf8").digest("hex")}.json`;

/**
 * One operator-owned record per canonical manifest under SPAWNFILE_HOME, never in the project
 * or its outputs. Approving one project never rewrites another project's record.
 */
export const resolveAdapterTrustPath = (manifestPath: string): string =>
  path.join(resolveSpawnfileHome(), ...TRUST_SEGMENTS, recordName(manifestPath));

const refuse = (where: string, message: string): never => {
  throw new SpawnfileError("validation_error", `Adapter trust store ${where}: ${message}`);
};

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const orMissing = <T>(promise: Promise<T>): Promise<T | undefined> =>
  promise.catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));

/** Treats `..name` entries as inside the parent; only `..` itself or `../x` escapes. */
const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};

/** Host-canonical form of a possibly missing path: realpath of its nearest existing ancestor plus the rest. */
const canonicalize = async (target: string): Promise<string> => {
  for (let probe = target; ; probe = path.dirname(probe)) {
    const resolved = await orMissing(realpath(probe));
    if (resolved !== undefined) return path.join(resolved, path.relative(probe, target));
    if (path.dirname(probe) === probe) return target;
  }
};

const checkOwnership = (stat: Stats, where: string, kind: string): void => {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) refuse(where, `${kind} is owned by another user`);
  if ((stat.mode & 0o022) !== 0) refuse(where, `${kind} is writable by group or others; remove group and other write access`);
};

/**
 * Follows the operator's SPAWNFILE_HOME (a link such as /var or an alias is allowed) to its real
 * host directory, which must itself be operator-owned and not group or other writable so no
 * other account can swap the trust directories below it. Each trust directory must then be a
 * real, operator-owned, non-shared directory outside the project. With `create`, a missing trust
 * directory is made one level at a time, only after its parent passed these checks, so a
 * redirected parent is refused before anything is created inside it. Returns undefined when no
 * approval has been stored yet.
 */
const resolveTrustDirectory = async (projectRoot: string, create = false): Promise<string | undefined> => {
  const configured = path.join(resolveSpawnfileHome(), ...TRUST_SEGMENTS);
  if (create) await mkdir(resolveSpawnfileHome(), { mode: 0o700, recursive: true });
  let directory = await orMissing(realpath(resolveSpawnfileHome()));
  if (directory === undefined) return undefined;
  const home = await lstat(directory);
  if (!home.isDirectory()) refuse(configured, "SPAWNFILE_HOME must be a directory");
  checkOwnership(home, configured, "SPAWNFILE_HOME");
  for (const segment of TRUST_SEGMENTS) {
    directory = path.join(directory, segment);
    let stat = await orMissing(lstat(directory));
    if (stat === undefined) {
      if (!create) return undefined;
      await mkdir(directory, { mode: 0o700 }).catch((error: unknown) =>
        (error as NodeJS.ErrnoException).code === "EEXIST" ? undefined : Promise.reject(error));
      stat = await lstat(directory);
    }
    if (!stat.isDirectory()) refuse(configured, "trust directory must be a real directory, not a link");
    checkOwnership(stat, configured, "trust directory");
  }
  if (isWithin(await realpath(projectRoot), directory)) refuse(configured, "trust records cannot live inside the project they approve");
  return directory;
};

const readTrustRecord = async (declared: DeclaredProjectAdapters): Promise<TrustRecord | undefined> => {
  const directory = await resolveTrustDirectory(declared.projectRoot);
  if (directory === undefined) return undefined;
  const file = path.join(directory, recordName(declared.manifestPath));
  const entry = await orMissing(lstat(file));
  if (entry === undefined) return undefined;
  if (entry.isSymbolicLink()) refuse(file, "trust records cannot be symbolic links");
  if (!entry.isFile() || entry.nlink !== 1) refuse(file, "expected a regular file with one link");
  // O_NONBLOCK keeps a FIFO swapped in after lstat from blocking; fstat below then refuses it.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ELOOP" ? refuse(file, "trust records cannot be symbolic links") : Promise.reject(error));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== entry.dev || stat.ino !== entry.ino) {
      refuse(file, "trust record changed while it was read");
    }
    checkOwnership(stat, file, "trust record");
    let data: unknown;
    try {
      data = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) refuse(file, "malformed JSON");
      throw error;
    }
    const parsed = trustRecordSchema.safeParse(data);
    return parsed.success ? parsed.data : refuse(file, "unrecognized trust record format");
  } finally {
    await handle.close();
  }
};

const sortedEntries = (adapters: AdapterEntries): Array<[string, string]> =>
  adapters.map(([name, specifier]): [string, string] => [name, specifier])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

const sameDeclarations = (left: AdapterEntries, right: AdapterEntries): boolean =>
  left.length === right.length && left.every(([name, specifier], index) => right[index]?.[0] === name && right[index]?.[1] === specifier);

export const isProjectAdapterSetTrusted = async (declared: DeclaredProjectAdapters): Promise<boolean> => {
  const record = await readTrustRecord(declared);
  return record !== undefined && record.manifestPath === declared.manifestPath
    && sameDeclarations(record.adapters, sortedEntries(declared.adapters));
};

/** Replaces the approval for one canonical manifest with its exact current declarations. Returns the record path. */
export const trustProjectAdapterSet = async (declared: DeclaredProjectAdapters): Promise<string> => {
  const configured = path.join(resolveSpawnfileHome(), ...TRUST_SEGMENTS);
  // Refuse before creating any directory so a project-contained home is never populated.
  if (isWithin(await realpath(declared.projectRoot), await canonicalize(configured))) {
    refuse(configured, "trust records cannot live inside the project they approve");
  }
  const directory = await resolveTrustDirectory(declared.projectRoot, true) ?? refuse(configured, "trust directory disappeared while it was created");
  const file = path.join(directory, recordName(declared.manifestPath));
  const record: TrustRecord = { adapters: sortedEntries(declared.adapters), manifestPath: declared.manifestPath, version: 1 };
  await writeDurableFile(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
};
