import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { activateNoReplace } from "./noReplaceActivation.js";

export const WORKSPACE_RESOURCE_MANIFEST_VERSION = "spawnfile.workspace-resource-manifest.v1" as const;
export const WORKSPACE_RESOURCE_MIGRATION_VERSION = "spawnfile.workspace-resource-migration.v1" as const;
const METADATA_MANIFEST = ".spawnfile-resource-migration-manifest.json";
const ACTIVATION_PROVENANCE = ".spawnfile-resource-activation-provenance";
const RESOURCE_IDENTITY = ".spawnfile-resource-identity";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024;

export interface WorkspaceResourceManifestFile {
  gid: number;
  mode: number;
  path: string;
  sha256: `sha256:${string}`;
  size: number;
  uid: number;
}

export interface WorkspaceResourceManifestDirectory {
  gid: number;
  mode: number;
  path: string;
  uid: number;
}

export interface WorkspaceResourceManifest {
  version: typeof WORKSPACE_RESOURCE_MANIFEST_VERSION;
  root: { gid: number; mode: number; uid: number };
  directories: WorkspaceResourceManifestDirectory[];
  files: WorkspaceResourceManifestFile[];
}

export interface WorkspaceResourceMigrationReceipt {
  version: typeof WORKSPACE_RESOURCE_MIGRATION_VERSION;
  active_path: string;
  destination_path: string;
  manifest_sha256: `sha256:${string}`;
  rollback: boolean;
  source_path: string;
  source_retained: true;
  status: "activated" | "rolled_back";
}

export interface WorkspaceResourceMigrationHooks {
  beforeActivation?: (destinationPath: string) => Promise<void>;
  afterActivation?: (destinationPath: string) => Promise<void>;
  afterCopy?: (temporaryPath: string) => Promise<void>;
  activate?: (temporaryPath: string, destinationPath: string) => Promise<void>;
  copy?: (sourcePath: string, temporaryPath: string) => Promise<void>;
  freeBytes?: (parentPath: string) => Promise<bigint>;
  withSourceWriteFence?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface WorkspaceResourceMigrationOptions {
  destinationPath: string;
  hooks?: WorkspaceResourceMigrationHooks;
  manifestPath: string;
  resolvedIdentity: string;
  sourceQuiesced?: boolean;
  sourcePath: string;
}

const digestBytes = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const fileDigest = async (file: string): Promise<`sha256:${string}`> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return `sha256:${hash.digest("hex")}`;
};

const safeRelativePath = (value: unknown): string => {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) throw new Error("Workspace resource manifest contains an unsafe path");
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) throw new Error("Workspace resource manifest contains an unsafe path");
  return normalized;
};

const integer = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Workspace resource manifest ${label} is invalid`);
  return value;
};

const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

const parseManifest = (value: unknown): WorkspaceResourceManifest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace resource manifest is invalid");
  const root = value as Record<string, unknown>;
  if (!exact(root, ["version", "root", "directories", "files"]) || root.version !== WORKSPACE_RESOURCE_MANIFEST_VERSION || !Array.isArray(root.directories) || !Array.isArray(root.files) || !root.root || typeof root.root !== "object" || Array.isArray(root.root)) throw new Error("Workspace resource manifest is invalid");
  const rootMetadata = root.root as Record<string, unknown>;
  if (!exact(rootMetadata, ["gid", "mode", "uid"])) throw new Error("Workspace resource manifest root metadata is invalid");
  const files = root.files.map((raw): WorkspaceResourceManifestFile => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Workspace resource manifest file is invalid");
    const file = raw as Record<string, unknown>;
    if (!exact(file, ["gid", "mode", "path", "sha256", "size", "uid"]) || typeof file.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256)) throw new Error("Workspace resource manifest file is invalid");
    return { gid: integer(file.gid, "file gid"), mode: integer(file.mode, "file mode"), path: safeRelativePath(file.path), sha256: file.sha256 as `sha256:${string}`, size: integer(file.size, "file size"), uid: integer(file.uid, "file uid") };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const directories = root.directories.map((raw): WorkspaceResourceManifestDirectory => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Workspace resource manifest directory is invalid");
    const directory = raw as Record<string, unknown>;
    if (!exact(directory, ["gid", "mode", "path", "uid"])) throw new Error("Workspace resource manifest directory is invalid");
    return { gid: integer(directory.gid, "directory gid"), mode: integer(directory.mode, "directory mode"), path: safeRelativePath(directory.path), uid: integer(directory.uid, "directory uid") };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const allPaths = [...directories.map((entry) => entry.path), ...files.map((entry) => entry.path)];
  if (new Set(allPaths).size !== allPaths.length || allPaths.some((entry) => entry === METADATA_MANIFEST || entry === ACTIVATION_PROVENANCE || entry === RESOURCE_IDENTITY)) throw new Error("Workspace resource manifest contains duplicate or reserved paths");
  return { version: WORKSPACE_RESOURCE_MANIFEST_VERSION, root: { gid: integer(rootMetadata.gid, "root gid"), mode: integer(rootMetadata.mode, "root mode"), uid: integer(rootMetadata.uid, "root uid") }, directories, files };
};

const inventory = async (root: string, relative = ""): Promise<{ directories: string[]; files: string[] }> => {
  const directories: string[] = []; const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Workspace resource contains a symlink: ${child}`);
    if (entry.isDirectory()) { directories.push(child); const nested = await inventory(root, child); directories.push(...nested.directories); files.push(...nested.files); }
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Workspace resource contains an unsupported entry: ${child}`);
  }
  return { directories: directories.sort(), files: files.sort() };
};

const verifyTree = async (root: string, manifest: WorkspaceResourceManifest, metadataDigest?: string, internal?: { activationToken: string; resolvedIdentity: string }): Promise<void> => {
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || rootEntry.uid !== manifest.root.uid || rootEntry.gid !== manifest.root.gid || (rootEntry.mode & 0o7777) !== manifest.root.mode) throw new Error("Workspace resource root metadata mismatch");
  const actual = await inventory(root); const internalFiles = new Set([METADATA_MANIFEST, ACTIVATION_PROVENANCE, RESOURCE_IDENTITY]);
  const actualFiles = actual.files.filter((entry) => !internalFiles.has(entry));
  if (actualFiles.join("\0") !== manifest.files.map((file) => file.path).join("\0") || actual.directories.join("\0") !== manifest.directories.map((directory) => directory.path).join("\0")) throw new Error("Workspace resource inventory does not match its manifest");
  for (const expected of manifest.directories) {
    const entry = await lstat(path.join(root, expected.path));
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== expected.uid || entry.gid !== expected.gid || (entry.mode & 0o7777) !== expected.mode) throw new Error(`Workspace resource directory metadata mismatch: ${expected.path}`);
  }
  for (const expected of manifest.files) {
    const entry = await stat(path.join(root, expected.path));
    if (!entry.isFile() || entry.size !== expected.size || entry.uid !== expected.uid || entry.gid !== expected.gid || (entry.mode & 0o7777) !== expected.mode || await fileDigest(path.join(root, expected.path)) !== expected.sha256) throw new Error(`Workspace resource checksum or metadata mismatch: ${expected.path}`);
  }
  if (metadataDigest !== undefined && await fileDigest(path.join(root, METADATA_MANIFEST)) !== metadataDigest) throw new Error("Workspace resource metadata manifest checksum mismatch");
  if (internal && ((await readFile(path.join(root, ACTIVATION_PROVENANCE), "utf8")) !== `${internal.activationToken}\n` || (await readFile(path.join(root, RESOURCE_IDENTITY), "utf8")) !== `${internal.resolvedIdentity}\n`)) throw new Error("Workspace resource authenticated migration identity mismatch");
};

const canonicalDestination = async (destinationPath: string): Promise<{ destination: string; parent: string }> => {
  if (!path.isAbsolute(destinationPath)) throw new Error("Workspace resource destination path must be absolute");
  const resolved = path.resolve(destinationPath);
  const parent = await realpath(path.dirname(resolved));
  const destination = path.join(parent, path.basename(resolved));
  return { destination, parent };
};

type DirectoryIdentity = { dev: number; ino: number };
const directoryIdentity = (entry: Awaited<ReturnType<typeof lstat>>): DirectoryIdentity => ({ dev: Number(entry.dev), ino: Number(entry.ino) });
const ownedDestinationIdentity = async (destination: string, token: string, expected?: DirectoryIdentity): Promise<DirectoryIdentity | undefined> => {
  try {
    const entry = await lstat(destination); const marker = path.join(destination, ACTIVATION_PROVENANCE); const markerEntry = await lstat(marker);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !markerEntry.isFile() || markerEntry.isSymbolicLink() || (await readFile(marker, "utf8")) !== `${token}\n`) return undefined;
    const actual = directoryIdentity(entry);
    return expected && (expected.dev !== actual.dev || expected.ino !== actual.ino) ? undefined : actual;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

interface MigrationJournal {
  version: "spawnfile.workspace-resource-migration-journal.v1";
  status: "prepared" | "activated";
  migration_id: string;
  parent: string;
  source_basename: string;
  destination_basename: string;
  source_path: string;
  destination_path: string;
  temporary_path: string;
  temporary_dev: number;
  temporary_ino: number;
  activation_token: string;
  manifest_sha256: `sha256:${string}`;
  resolved_identity: string;
}

const writeJournal = async (journalPath: string, journal: MigrationJournal): Promise<void> => {
  const bytes = `${JSON.stringify(journal)}\n`; if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES) throw new Error("Workspace resource migration journal is too large");
  const temporary = `${journalPath}.write-${randomUUID()}`; const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, journalPath);
  const parentHandle = await open(path.dirname(journalPath), "r"); try { await parentHandle.sync(); } finally { await parentHandle.close(); }
};

const syncDirectory = async (directory: string): Promise<void> => { const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } };

const readJournal = async (journalPath: string): Promise<MigrationJournal | undefined> => {
  try {
    const entry = await lstat(journalPath); if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > MAX_JOURNAL_BYTES) throw new Error("Workspace resource migration journal is invalid");
    const value = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    const keys = ["version", "status", "migration_id", "parent", "source_basename", "destination_basename", "source_path", "destination_path", "temporary_path", "temporary_dev", "temporary_ino", "activation_token", "manifest_sha256", "resolved_identity"];
    if (!value || !exact(value, keys) || value.version !== "spawnfile.workspace-resource-migration-journal.v1" || !["prepared", "activated"].includes(String(value.status)) || typeof value.migration_id !== "string" || typeof value.parent !== "string" || typeof value.source_basename !== "string" || typeof value.destination_basename !== "string" || typeof value.source_path !== "string" || typeof value.destination_path !== "string" || typeof value.temporary_path !== "string" || !Number.isSafeInteger(value.temporary_dev) || !Number.isSafeInteger(value.temporary_ino) || typeof value.activation_token !== "string" || typeof value.manifest_sha256 !== "string" || typeof value.resolved_identity !== "string") throw new Error("Workspace resource migration journal is invalid");
    return value as unknown as MigrationJournal;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

export const migrateWorkspaceResource = async (options: WorkspaceResourceMigrationOptions): Promise<WorkspaceResourceMigrationReceipt> => {
  if (!path.isAbsolute(options.sourcePath) || !path.isAbsolute(options.manifestPath)) throw new Error("Workspace resource source and manifest paths must be absolute");
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.resolvedIdentity)) throw new Error("Workspace resource resolved identity is invalid");
  if (options.sourceQuiesced !== true && options.hooks?.withSourceWriteFence === undefined) throw new Error("Workspace resource migration requires explicit source quiescence or a write-fence authority");
  const sourceEntry = await lstat(options.sourcePath);
  const source = await realpath(options.sourcePath);
  if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) throw new Error("Workspace resource source must be one canonical directory");
  const { destination, parent } = await canonicalDestination(options.destinationPath);
  if (destination === source || destination.startsWith(`${source}${path.sep}`) || source.startsWith(`${destination}${path.sep}`)) throw new Error("Workspace resource source and destination must not overlap");
  const manifestEntry = await lstat(options.manifestPath);
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink() || manifestEntry.size < 1 || manifestEntry.size > MAX_MANIFEST_BYTES) throw new Error("Workspace resource manifest must be a bounded regular file");
  const manifestBytes = await readFile(options.manifestPath);
  const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (sourceEntry.uid !== manifest.root.uid || sourceEntry.gid !== manifest.root.gid || (sourceEntry.mode & 0o7777) !== manifest.root.mode) throw new Error("Workspace resource source owner or mode does not match its manifest");
  await verifyTree(source, manifest);
  const requiredBytes = BigInt(manifest.files.reduce((total, file) => total + file.size, manifestBytes.length));
  const freeBytes = options.hooks?.freeBytes ?? (async (target: string) => { const value = await statfs(target, { bigint: true }); return value.bavail * value.bsize; });
  if (await freeBytes(parent) < requiredBytes) throw new Error("Workspace resource destination has insufficient free space");
  if (options.hooks?.activate === undefined && process.platform === "linux") {
    const filesystem = await statfs(parent, { bigint: true });
    const localTypes = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n]);
    if (!localTypes.has(filesystem.type)) throw new Error("Workspace resource migration requires unambiguous local filesystem authority");
  }

  const copy = options.hooks?.copy ?? (async (from, to) => await cp(from, to, { errorOnExist: true, force: false, preserveTimestamps: true, recursive: true }));
  const activate = options.hooks?.activate ?? activateNoReplace;
  const withSourceWriteFence = options.hooks?.withSourceWriteFence ?? (async <T>(operation: () => Promise<T>) => await operation());
  const manifestSha256 = digestBytes(manifestBytes);
  const journalPath = `${destination}.migration-journal.json`;
  const recovered = await readJournal(journalPath);
  if (recovered && (recovered.parent !== parent || recovered.source_basename !== path.basename(source) || recovered.destination_basename !== path.basename(destination) || recovered.source_path !== source || recovered.destination_path !== destination || path.dirname(recovered.temporary_path) !== parent || !path.basename(recovered.temporary_path).startsWith(`${path.basename(destination)}.migration-`) || recovered.manifest_sha256 !== manifestSha256 || recovered.resolved_identity !== options.resolvedIdentity)) throw new Error("Workspace resource migration journal does not match this migration");
  let temporary = recovered?.temporary_path ?? `${destination}.migration-${randomUUID()}`;
  let activationToken = recovered?.activation_token ?? randomUUID(); let migrationId = recovered?.migration_id ?? randomUUID();
  let activatedIdentity: DirectoryIdentity | undefined = recovered ? { dev: recovered.temporary_dev, ino: recovered.temporary_ino } : undefined;
  let resume = false;
  if (recovered) {
    const destinationOwned = await ownedDestinationIdentity(destination, activationToken, activatedIdentity);
    const destinationExact = await (async () => { try { const entry = await lstat(destination); const actual = directoryIdentity(entry); return actual.dev === activatedIdentity?.dev && actual.ino === activatedIdentity?.ino; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } })();
    if (destinationOwned || (recovered.status === "activated" && destinationExact && await readFile(path.join(destination, RESOURCE_IDENTITY), "utf8") === `${options.resolvedIdentity}\n`)) {
      await verifyTree(destination, manifest, manifestSha256, destinationOwned ? { activationToken, resolvedIdentity: options.resolvedIdentity } : undefined);
      await writeJournal(journalPath, { ...recovered, status: "activated" }); await rm(path.join(destination, ACTIVATION_PROVENANCE), { force: true });
      return { version: WORKSPACE_RESOURCE_MIGRATION_VERSION, active_path: destination, destination_path: destination, manifest_sha256: manifestSha256, rollback: false, source_path: source, source_retained: true, status: "activated" };
    }
    if (await ownedDestinationIdentity(temporary, activationToken, activatedIdentity)) { await verifyTree(temporary, manifest, manifestSha256, { activationToken, resolvedIdentity: options.resolvedIdentity }); resume = true; }
    else throw new Error("Workspace resource migration journal has no recoverable owned state");
  } else {
    try { await lstat(destination); throw new Error("Workspace resource destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try {
    if (!resume) {
      await copy(source, temporary);
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, METADATA_MANIFEST), manifestBytes, { flag: "wx", mode: 0o600 });
      await writeFile(path.join(temporary, ACTIVATION_PROVENANCE), `${activationToken}\n`, { flag: "wx", mode: 0o600 });
      await writeFile(path.join(temporary, RESOURCE_IDENTITY), `${options.resolvedIdentity}\n`, { flag: "wx", mode: 0o600 });
      await options.hooks?.afterCopy?.(temporary);
      await verifyTree(temporary, manifest, manifestSha256, { activationToken, resolvedIdentity: options.resolvedIdentity });
      activatedIdentity = directoryIdentity(await lstat(temporary));
    }
    if (!activatedIdentity) throw new Error("Workspace resource temporary identity is unavailable");
    const journal: MigrationJournal = { version: "spawnfile.workspace-resource-migration-journal.v1", status: "prepared", migration_id: migrationId, parent, source_basename: path.basename(source), destination_basename: path.basename(destination), source_path: source, destination_path: destination, temporary_path: temporary, temporary_dev: activatedIdentity.dev, temporary_ino: activatedIdentity.ino, activation_token: activationToken, manifest_sha256: manifestSha256, resolved_identity: options.resolvedIdentity };
    await writeJournal(journalPath, journal);
    await withSourceWriteFence(async () => {
      const currentSource = await lstat(source);
      if (currentSource.dev !== sourceEntry.dev || currentSource.ino !== sourceEntry.ino) throw new Error("Workspace resource source identity changed before activation");
      await verifyTree(source, manifest);
      await options.hooks?.beforeActivation?.(destination);
      await activate(temporary, destination);
      await syncDirectory(parent);
    });
    if (await ownedDestinationIdentity(destination, activationToken, activatedIdentity) === undefined) throw new Error("Workspace resource activation provenance is unavailable");
    await verifyTree(destination, manifest, manifestSha256, { activationToken, resolvedIdentity: options.resolvedIdentity });
    await writeJournal(journalPath, { ...journal, status: "activated" });
    await options.hooks?.afterActivation?.(destination);
    await rm(path.join(destination, ACTIVATION_PROVENANCE));
    return { version: WORKSPACE_RESOURCE_MIGRATION_VERSION, active_path: destination, destination_path: destination, manifest_sha256: manifestSha256, rollback: false, source_path: source, source_retained: true, status: "activated" };
  } catch (error) {
    const owned = await ownedDestinationIdentity(destination, activationToken, activatedIdentity);
    if (owned === undefined) {
      await rm(temporary, { force: true, recursive: true }); await rm(journalPath, { force: true }); throw error;
    }
    await rm(destination, { force: true, recursive: true });
    await rm(journalPath, { force: true });
    return { version: WORKSPACE_RESOURCE_MIGRATION_VERSION, active_path: source, destination_path: destination, manifest_sha256: manifestSha256, rollback: true, source_path: source, source_retained: true, status: "rolled_back" };
  }
};

export const buildWorkspaceResourceManifest = async (sourcePath: string): Promise<WorkspaceResourceManifest> => {
  const source = await realpath(sourcePath); const root = await stat(source); const entries = await inventory(source);
  const directories = await Promise.all(entries.directories.map(async (relative): Promise<WorkspaceResourceManifestDirectory> => {
    const entry = await lstat(path.join(source, relative));
    return { gid: entry.gid, mode: entry.mode & 0o7777, path: relative, uid: entry.uid };
  }));
  const files = await Promise.all(entries.files.map(async (relative): Promise<WorkspaceResourceManifestFile> => {
    const entry = await stat(path.join(source, relative));
    return { gid: entry.gid, mode: entry.mode & 0o7777, path: relative, sha256: await fileDigest(path.join(source, relative)), size: entry.size, uid: entry.uid };
  }));
  return { version: WORKSPACE_RESOURCE_MANIFEST_VERSION, root: { gid: root.gid, mode: root.mode & 0o7777, uid: root.uid }, directories, files };
};
