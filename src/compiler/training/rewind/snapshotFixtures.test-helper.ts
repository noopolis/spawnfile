import { chmod, lstat, mkdir, readdir, readlink, writeFile, appendFile, symlink } from "node:fs/promises";
import path from "node:path";

interface SnapshotFixture {
  agentSlug: string; agentId: string; rootId: string; snapshot: string; startedAt: string;
  files: Record<string, string>; executionId?: string;
  directories?: Record<string, number>; symlinks?: Record<string, string>;
}

/** Recorder-format data only: no runtime dependency on Daimon. */
export const writeRecordedVolumeSnapshot = async (historyRoot: string, options: SnapshotFixture) => {
  const recording = path.join(historyRoot, "recording", options.agentSlug);
  const base = path.join(recording, "snapshots", options.rootId);
  const directory = path.join(base, options.snapshot), manifestPath = `${directory}.manifest.json`;
  const rowsPath = path.join(recording, "wake-moments.jsonl");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [relative, mode] of Object.entries(options.directories ?? {})) {
    await mkdir(path.join(directory, relative), { recursive: true }); await chmod(path.join(directory, relative), mode);
  }
  for (const [relative, text] of Object.entries(options.files)) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), text);
  }
  for (const [relative, target] of Object.entries(options.symlinks ?? {})) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await symlink(target, path.join(directory, relative));
  }
  const entries: Record<string, unknown> = {};
  const visit = async (relative: string): Promise<void> => {
    for (const name of await readdir(path.join(directory, relative))) {
      const rel = relative ? `${relative}/${name}` : name, file = path.join(directory, rel);
      const stat = await lstat(file, { bigint: true });
      const type = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file";
      entries[rel] = { type, mode: Number(stat.mode), size: String(stat.size), source: {
        dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), mode: Number(stat.mode)
      }, ...(type === "symlink" ? { target: await readlink(file) } : {}) };
      if (type === "directory") await visit(rel);
    }
  };
  await visit("");
  const manifest = { version: "noopolis.daimon.wake-moment.v1", id: options.rootId, snapshot: options.snapshot,
    started_at: options.startedAt, sourcePath: `/deployment/${options.rootId}`, entries };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await writeFile(`${directory}.complete`, "");
  await appendFile(rowsPath, `${JSON.stringify({ version: manifest.version, agent_id: options.agentId,
    execution_id: options.executionId ?? "execution", started_at: options.startedAt,
    deliveries: [{ acceptance_id: "acceptance", delivery_id: "delivery", kind: "manual", occurred_at: options.startedAt }],
    snapshots: [{ id: options.rootId, snapshot: options.snapshot, files: Object.keys(options.files).length,
      copied: Object.keys(options.files).length, linked: 0, skipped: 0 }] })}\n`);
  return { directory, manifestPath, rowsPath, manifest };
};
