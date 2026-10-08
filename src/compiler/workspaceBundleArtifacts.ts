import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpawnfileError } from "../shared/index.js";
import type { CompilePlan } from "./types.js";

// Sanity bound for an operator-declared local tar; integrity comes from its digest, not its size.
const CAP = 536_870_912, BLOCK = 512;
// Sanity bound on an operator-declared local tar; integrity comes from the declared digest.
const MAX_WORKSPACE_BUNDLE_ENTRIES = 65_536;
const fail = (message = "Workspace bundle contains an invalid or unsafe tar entry"): never => { throw new SpawnfileError("validation_error", message); };
const textField = (field: Buffer): string => { const nul = field.indexOf(0); return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8"); };
const octal = (field: Buffer, allowEmpty = false): number => {
  const value = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (value === "" && allowEmpty) return 0;
  if (!/^[0-7]+$/u.test(value)) fail();
  const parsed = Number.parseInt(value, 8); if (!Number.isSafeInteger(parsed) || parsed < 0) fail(); return parsed;
};
const validPath = (value: string, directory: boolean): string => {
  const name = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) fail();
  const parts = name.split("/"); if (parts.some((part) => !part || part === "." || part === "..")) fail(); return parts.join("/");
};
const validChecksum = (header: Buffer): boolean => {
  const expected = octal(header.subarray(148, 156)); let actual = 0;
  for (let index = 0; index < BLOCK; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index]!;
  return actual === expected;
};

export const validateWorkspaceBundleTar = (bytes: Buffer): void => {
  if (bytes.length < BLOCK * 2 || bytes.length % BLOCK !== 0) fail("Workspace bundle is truncated or lacks exact ustar termination");
  let offset = 0, entries = 0, terminated = false; const names = new Set<string>();
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (offset + BLOCK * 2 > bytes.length || !bytes.subarray(offset, offset + BLOCK * 2).every((byte) => byte === 0) || !bytes.subarray(offset + BLOCK * 2).every((byte) => byte === 0)) fail("Workspace bundle has invalid termination or trailing bytes");
      terminated = true; break;
    }
    if (textField(header.subarray(257, 263)) !== "ustar" || !validChecksum(header)) fail();
    for (const [start, end, empty] of [[100, 108, false], [108, 116, true], [116, 124, true], [124, 136, false], [136, 148, true], [329, 337, true], [337, 345, true]] as const) octal(header.subarray(start, end), empty);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!); if (type !== "0" && type !== "5") fail();
    const size = octal(header.subarray(124, 136)); if (type === "5" && size !== 0) fail();
    const prefix = textField(header.subarray(345, 500)), rawName = textField(header.subarray(0, 100));
    const effective = validPath(prefix ? `${prefix}/${rawName}` : rawName, type === "5"); if (names.has(effective)) fail("Workspace bundle contains duplicate effective paths"); names.add(effective);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK; entries += 1;
    if (offset > bytes.length) fail("Workspace bundle is truncated or exceeds entry bounds");
    if (entries > MAX_WORKSPACE_BUNDLE_ENTRIES) fail("Workspace bundle exceeds the maximum entry count");
  }
  if (!terminated) fail("Workspace bundle is truncated or lacks exact ustar termination"); if (entries === 0) fail("Workspace bundle is empty");
};

export const workspaceBundleContextPath = (outputDirectory: string, identity: string): string =>
  path.join(outputDirectory, "container/workspace-bundles", `${identity.slice(7)}.tar`);

/**
 * Hard-links a read-only cached archive into the Docker context (cloning or
 * copying across filesystems). Never writes through an existing name: with
 * `clean: false` it may already be a link into the cache. Returns the staged
 * path, or undefined when the cached archive no longer exists.
 */
export const linkBuiltBundle = async (archive: string, outputDirectory: string, identity: string): Promise<string | undefined> => {
  const target = workspaceBundleContextPath(outputDirectory, identity);
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { force: true });
  try { await link(archive, target); return target; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  }
  try { await copyFile(archive, target, constants.COPYFILE_FICLONE); return target; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/**
 * Completes the bundle archives in the Docker context. Built bundles were
 * already linked by `resolveWorkspaceBundles` (`built` maps their digests to
 * the staged path). Every `source` tar is hashed, validated and staged from
 * the exact bytes that were verified, even when a built bundle shares its
 * digest; distinct source paths with identical bytes stage once.
 */
export const stageWorkspaceBundles = async (outputDirectory: string, plan: CompilePlan, built: ReadonlyMap<string, string> = new Map()): Promise<boolean> => {
  const sources = new Map<string, Set<string>>();
  let any = false;
  for (const node of plan.nodes) if (node.kind === "agent") for (const resource of node.value.workspaceResources ?? []) {
    if (resource.kind !== "bundle") continue;
    any = true;
    if (resource.sha256 === undefined || (resource.source === undefined && !built.has(resource.sha256))) {
      throw new SpawnfileError("compile_error", `Workspace bundle ${resource.id} has not been built`);
    }
    if (resource.source === undefined) continue;
    const paths = sources.get(resource.sha256) ?? new Set<string>();
    paths.add(path.resolve(path.dirname(resource.scope.key), resource.source)); sources.set(resource.sha256, paths);
  }
  if (!any) return false;
  await mkdir(path.join(outputDirectory, "container/workspace-bundles"), { recursive: true });
  for (const [identity, paths] of sources) {
    let verified: Buffer | undefined;
    for (const source of paths) {
      const info = await stat(source); if (!info.isFile() || info.size < 1 || info.size > CAP) throw new SpawnfileError("validation_error", "Workspace bundle must be a bounded regular tar file");
      const bytes = await readFile(source); const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`; if (actual !== identity) throw new SpawnfileError("validation_error", "Workspace bundle checksum mismatch");
      validateWorkspaceBundleTar(bytes); verified ??= bytes;
    }
    // Replace by unlinking first: the name may be a hard link into the bundle cache.
    const target = workspaceBundleContextPath(outputDirectory, identity); await rm(target, { force: true });
    await writeFile(target, verified!);
  }
  return true;
};
