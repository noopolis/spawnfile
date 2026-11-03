import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { DAIMON_ORGANIZATION_UID } from "../../../runtime/daimon/runtimeIdentity.js";
import { SpawnfileError } from "../../../shared/index.js";
import { digestDirectory, FEED_IDENTITY_VERSION } from "../../../volume/index.js";
import { normalizeBundleMode, ustarHeader } from "../../workspaceBundleTar.js";
import type { TrainingMoment, TrainingMomentFill } from "../moments.js";
import type { TrialDocker } from "./docker.js";

const run = promisify(execFile);
const MAX_FILL_BYTES = 512 * 1024 * 1024;
const fail = (message: string): never => { throw new SpawnfileError("runtime_error", message); };

/** Where one moment resource lands: the trial's own fresh volume, mounted where the organization mounts it. */
export interface MomentVolume {
  id: string;
  volume: string;
  mountPath: string;
  /** The compiled resource identity the entrypoint verifies on start. */
  identity: string;
  /** The declared name production feeds, recorded in the feed identity agents read. */
  declaredName: string;
  fill: TrainingMomentFill;
}

/** The ustar stream of `files` (path to bytes), every entry a regular file. */
export const tarOf = (files: ReadonlyArray<readonly [string, Buffer, number]>): Buffer => {
  const chunks: Buffer[] = [];
  for (const [name, bytes, mode] of [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    chunks.push(ustarHeader(name, bytes.length, normalizeBundleMode(mode)), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
};

const directoryFiles = async (root: string): Promise<[string, Buffer, number][]> => {
  const files: [string, Buffer, number][] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) fail(`Moment directory ${root} holds a link: ${file}`);
    if (stat.isFile()) files.push([path.relative(root, file).split(path.sep).join("/"), await readFile(file), stat.mode]);
  }
  return files;
};

/** The tar a fill streams into its volume, and the tree it lands as (null: at the volume root). */
const contentOf = async (fill: TrainingMomentFill): Promise<{ tar: Buffer; tree: string | null } | null> => {
  if (fill.kind === "empty") return null;
  if (fill.kind === "files") return { tree: null, tar: tarOf(Object.entries(fill.files).map(([name, text]) => [name, Buffer.from(text), 0o644] as const)) };
  if (fill.kind === "directory") {
    if (digestDirectory(fill.directory) !== fill.revision) fail(`Moment directory ${fill.directory} changed since lowering`);
    return { tree: fill.revision, tar: tarOf(await directoryFiles(fill.directory)) };
  }
  const { stdout } = await run("git", ["-C", fill.repo, "archive", "--format=tar", fill.commit, ...(fill.paths ? ["--", ...fill.paths] : [])],
    { encoding: "buffer", maxBuffer: MAX_FILL_BYTES });
  return { tree: fill.revision, tar: stdout };
};

/**
 * Runs as root in a network-less helper on the organization's own image, the volume mounted where the
 * organization mounts it so a fresh volume gets the image's bootstrap preimage first. Refuses a volume that
 * holds anything else, hands its root to the organization uid, extracts the content as that uid (a feed
 * lands as `trees/<revision>`, frozen, served through `current`, with the feed identity record agents read;
 * inline files land at the root), then writes the replacement sentinel the entrypoint verifies.
 */
export const MOMENT_FILL_PROGRAM = [
  "const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');",
  "const [uidText, root, identity, tree, feedRecord] = process.argv.slice(1); const uid = Number(uidText), privileged = process.getuid() === 0;",
  "const fail = (message) => { console.error(message); process.exit(3); };",
  "process.chdir(root); const marker = '.spawnfile-volume-init';",
  "const names = fs.readdirSync('.'); if (names.some((name) => name !== marker)) fail('moment volume is not fresh');",
  "if (names.includes(marker)) fs.unlinkSync(marker);",
  "if (privileged) fs.chownSync('.', uid, uid); fs.chmodSync('.', 0o755);",
  "const asUid = (command, args, input) => { const result = spawnSync(command, args, { ...(privileged ? { uid, gid: uid } : {}), input, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] }); if (result.status !== 0) fail(`${command} failed`); };",
  "const input = fs.readFileSync(0);",
  "if (input.length > 0) {",
  "  const target = tree ? `trees/${tree}` : '.';",
  "  if (tree) asUid('mkdir', ['-p', target]);",
  "  asUid('tar', ['-x', '--no-same-owner', '-f', '-', '-C', target], input);",
  "  for (const name of fs.readdirSync('.')) if (!tree && name.startsWith('.spawnfile-')) fail('moment files may not name a .spawnfile- entry at the volume root');",
  "  if (tree) {",
  "    asUid('chmod', ['-R', 'a-w', target]); asUid('chmod', ['0755', target]);",
  "    fs.symlinkSync(target, 'current'); if (privileged) fs.lchownSync('current', uid, uid);",
  "    fs.writeFileSync('.spawnfile-feed.json', feedRecord, { mode: 0o644, flag: 'wx' }); if (privileged) fs.chownSync('.spawnfile-feed.json', uid, uid);",
  "  }",
  "}",
  "fs.writeFileSync('.spawnfile-resource-identity', `${identity}\\n`, { mode: 0o644, flag: 'wx' }); if (privileged) fs.chownSync('.spawnfile-resource-identity', 0, 0); fs.chmodSync('.spawnfile-resource-identity', 0o644);"
].join("\n");

const countEntries = (tar: Buffer): number => {
  let count = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/su, "").trim() || "0", 8);
    if (header[156] === 0x30 || header[156] === 0) count++;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return count;
};

/** Creates and fills each moment volume before the organization boots. Every volume is the trial's own. */
export const fillMomentVolumes = async (docker: TrialDocker, image: string, volumes: readonly MomentVolume[]): Promise<void> => {
  for (const volume of volumes) {
    const content = await contentOf(volume.fill);
    const feedRecord = content?.tree ? `${JSON.stringify({
      files: countEntries(content.tar), landed_at: new Date().toISOString(), resource: volume.id, revision: content.tree,
      source: (volume.fill as Extract<TrainingMomentFill, { source: unknown }>).source, tree: `trees/${content.tree}`,
      version: FEED_IDENTITY_VERSION, volume: volume.declaredName
    }, null, 2)}\n` : "";
    await docker(["volume", "create", volume.volume]);
    await docker([
      "run", "--rm", "-i", "--network", "none", "--user", "0:0", "--cap-drop", "ALL",
      "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "SETUID", "--cap-add", "SETGID",
      "--security-opt", "no-new-privileges", "--entrypoint", "node",
      "--mount", `type=volume,source=${volume.volume},target=${volume.mountPath}`,
      image, "-e", MOMENT_FILL_PROGRAM, String(DAIMON_ORGANIZATION_UID), volume.mountPath, volume.identity, content?.tree ?? "", feedRecord
    ], { stdin: content?.tar ?? Buffer.alloc(0), timeoutMs: 600_000 });
  }
};

/** Pairs each moment resource with the compiled workspace volume it replaces. */
export const momentVolumesFor = (
  moment: TrainingMoment,
  report: { workspace_resources?: readonly { id: string; kind: string; backing_path?: string; resolved_identity?: string; volume_name?: string | null }[];
    persistent_mounts?: readonly { mount_path: string; volume_name: string; declared_volume_name?: string }[] }
): MomentVolume[] => moment.resources.map((resource) => {
  const compiled = report.workspace_resources?.find((entry) => entry.id === resource.id && entry.kind === "volume")
    ?? fail(`Moment resource ${resource.id} is not a workspace volume of the trial organization`);
  const mount = report.persistent_mounts?.find((entry) => entry.mount_path === compiled.backing_path)
    ?? fail(`Moment resource ${resource.id} has no persistent mount`);
  if (!compiled.resolved_identity) fail(`Moment resource ${resource.id} has no compiled identity`);
  return { id: resource.id, volume: mount.volume_name, mountPath: mount.mount_path, identity: compiled.resolved_identity!,
    declaredName: mount.declared_volume_name ?? compiled.volume_name ?? mount.volume_name, fill: resource.fill };
});
