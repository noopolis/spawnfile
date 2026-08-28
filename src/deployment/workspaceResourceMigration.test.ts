import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildWorkspaceResourceManifest,
  migrateWorkspaceResource,
  type WorkspaceResourceMigrationHooks
} from "./workspaceResourceMigration.js";

const roots: string[] = [];
const resolvedIdentity = `sha256:${"b".repeat(64)}`;
const execFile = promisify(execFileCallback);

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-resource-migration-")); roots.push(root);
  const sourcePath = path.join(root, "r28-source"); const destinationPath = path.join(root, "volumes", "r28");
  await mkdir(path.join(sourcePath, "nested"), { recursive: true }); await chmod(sourcePath, 0o700);
  await writeFile(path.join(sourcePath, "nested", "edition.jsonl"), "one\ntwo\n", { mode: 0o600 });
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const manifest = await buildWorkspaceResourceManifest(sourcePath);
  const manifestPath = path.join(root, "r28-manifest.json"); await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { destinationPath, manifestPath, resolvedIdentity, root, sourcePath, sourceQuiesced: true as const };
};

const freeSpace = { freeBytes: async () => 10_000_000n, activate: async (source: string, destination: string) => await rename(source, destination) };
const failExisting = async (source: string, destination: string) => {
  try { await lstat(destination); const error = new Error("exists") as NodeJS.ErrnoException; error.code = "EEXIST"; throw error; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rename(source, destination);
};
const crashAtActivation = async (input: Awaited<ReturnType<typeof fixture>>, after: boolean) => {
  const moduleUrl = pathToFileURL(path.resolve("src/deployment/workspaceResourceMigration.ts")).href;
  const script = `import { rename } from "node:fs/promises"; import { migrateWorkspaceResource } from ${JSON.stringify(moduleUrl)}; const input=JSON.parse(process.argv[1]); await migrateWorkspaceResource({...input,sourceQuiesced:true,hooks:{freeBytes:async()=>10000000n,activate:async(from,to)=>{${after ? "await rename(from,to);" : ""}process.exit(91)}}});`;
  await expect(execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(input)])).rejects.toMatchObject({ code: 91 });
};
const leftovers = async (root: string) => (await readdir(path.join(root, "volumes"))).filter((entry) => entry.includes(".migration-") && !entry.endsWith(".migration-journal.json"));

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

describe("workspace resource live migration", () => {
  it("preflights, checksums, atomically activates, and retains the source", async () => {
    const input = await fixture();
    const receipt = await migrateWorkspaceResource({ ...input, hooks: freeSpace });
    expect(receipt).toMatchObject({ active_path: receipt.destination_path, rollback: false, source_retained: true, status: "activated" });
    await expect(readFile(path.join(input.destinationPath, "nested", "edition.jsonl"), "utf8")).resolves.toBe("one\ntwo\n");
    await expect(readFile(path.join(input.sourcePath, "nested", "edition.jsonl"), "utf8")).resolves.toBe("one\ntwo\n");
    await expect(readFile(path.join(input.destinationPath, ".spawnfile-resource-identity"), "utf8")).resolves.toBe(`${resolvedIdentity}\n`);
    expect((await stat(input.destinationPath)).mode & 0o777).toBe(0o700);
    expect(await leftovers(input.root)).toEqual([]);
  });

  it("removes only temporary data after injected copy failure", async () => {
    const input = await fixture();
    await expect(migrateWorkspaceResource({ ...input, hooks: { ...freeSpace, copy: async (_source, temporary) => { await mkdir(temporary); await writeFile(path.join(temporary, "partial"), "partial"); throw new Error("copy failed"); } } })).rejects.toThrow("copy failed");
    await expect(readFile(path.join(input.sourcePath, "nested", "edition.jsonl"), "utf8")).resolves.toBe("one\ntwo\n");
    expect(await leftovers(input.root)).toEqual([]);
  });

  it("removes only temporary data after injected checksum failure", async () => {
    const input = await fixture();
    const hooks: WorkspaceResourceMigrationHooks = {
      ...freeSpace,
      copy: async (source, temporary) => await cp(source, temporary, { recursive: true, preserveTimestamps: true }),
      afterCopy: async (temporary) => await writeFile(path.join(temporary, "nested", "edition.jsonl"), "corrupt\n")
    };
    await expect(migrateWorkspaceResource({ ...input, hooks })).rejects.toThrow(/checksum or metadata mismatch/u);
    await expect(readFile(path.join(input.sourcePath, "nested", "edition.jsonl"), "utf8")).resolves.toBe("one\ntwo\n");
    expect(await leftovers(input.root)).toEqual([]);
  });

  it("removes only temporary data after injected activation failure", async () => {
    const input = await fixture();
    await expect(migrateWorkspaceResource({ ...input, hooks: { ...freeSpace, activate: async () => { throw new Error("activation failed"); } } })).rejects.toThrow("activation failed");
    await expect(readFile(path.join(input.sourcePath, "nested", "edition.jsonl"), "utf8")).resolves.toBe("one\ntwo\n");
    expect(await leftovers(input.root)).toEqual([]);
  });

  it("rolls back to the retained source after post-activation failure", async () => {
    const input = await fixture();
    const receipt = await migrateWorkspaceResource({ ...input, hooks: { ...freeSpace, afterActivation: async () => { throw new Error("post activation failed"); } } });
    expect(receipt).toMatchObject({ active_path: receipt.source_path, rollback: true, source_retained: true, status: "rolled_back" });
    await expect(stat(input.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(input.sourcePath, "nested", "edition.jsonl"), "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("detects an activation that moved data before failing and rolls it back", async () => {
    const input = await fixture();
    const receipt = await migrateWorkspaceResource({ ...input, hooks: { ...freeSpace, activate: async (temporary, destination) => { await rename(temporary, destination); throw new Error("activation acknowledgement lost"); } } });
    expect(receipt).toMatchObject({ active_path: receipt.source_path, rollback: true, source_retained: true, status: "rolled_back" });
    await expect(stat(input.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(input.sourcePath, "nested", "edition.jsonl"), "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("preserves an unrelated destination created by a failing activation", async () => {
    const input = await fixture();
    await expect(migrateWorkspaceResource({ ...input, hooks: { ...freeSpace, activate: failExisting, beforeActivation: async (destination) => { await mkdir(destination); await writeFile(path.join(destination, "unrelated"), "keep\n"); } } })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(path.join(input.destinationPath, "unrelated"), "utf8")).resolves.toBe("keep\n");
  });

  it("atomically rejects a concurrently created empty destination without replacing its inode", async () => {
    const input = await fixture(); let racedInode: bigint | undefined;
    await expect(migrateWorkspaceResource({ ...input, hooks: { ...freeSpace, activate: failExisting, beforeActivation: async (destination) => { await mkdir(destination); racedInode = (await lstat(destination, { bigint: true })).ino; } } })).rejects.toMatchObject({ code: "EEXIST" });
    expect((await lstat(input.destinationPath, { bigint: true })).ino).toBe(racedInode);
    expect(await readdir(input.destinationPath)).toEqual([]);
  });

  it("fails closed without quiescence and catches a post-copy source mutation", async () => {
    const input = await fixture();
    await expect(migrateWorkspaceResource({ ...input, sourceQuiesced: false })).rejects.toThrow(/requires explicit source quiescence/u);
    await expect(migrateWorkspaceResource({ ...input, hooks: { ...freeSpace, afterCopy: async () => await writeFile(path.join(input.sourcePath, "nested", "edition.jsonl"), "changed\n") } })).rejects.toThrow(/checksum or metadata mismatch/u);
    await expect(stat(input.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects copied root and nested-directory metadata corruption", async () => {
    const rootCorruption = await fixture();
    await expect(migrateWorkspaceResource({ ...rootCorruption, hooks: { ...freeSpace, afterCopy: async (temporary) => await chmod(temporary, 0o755) } })).rejects.toThrow(/root metadata mismatch/u);
    const nestedCorruption = await fixture();
    await expect(migrateWorkspaceResource({ ...nestedCorruption, hooks: { ...freeSpace, afterCopy: async (temporary) => await chmod(path.join(temporary, "nested"), 0o700) } })).rejects.toThrow(/directory metadata mismatch/u);
  });

  it("rejects a corrupted authenticated migration identity", async () => {
    const input = await fixture();
    await expect(migrateWorkspaceResource({ ...input, hooks: { ...freeSpace, afterCopy: async (temporary) => await writeFile(path.join(temporary, ".spawnfile-resource-identity"), "sha256:wrong\n") } })).rejects.toThrow(/authenticated migration identity mismatch/u);
    await expect(stat(input.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed in production on a non-Linux host", async () => {
    if (process.platform === "linux") return;
    const input = await fixture();
    await expect(migrateWorkspaceResource({ ...input, hooks: { freeBytes: freeSpace.freeBytes } })).rejects.toThrow(/unsupported on this platform/u);
    await expect(stat(input.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes exact journal-owned temporary data after a crash before activation", async () => {
    const input = await fixture(); await crashAtActivation(input, false);
    const receipt = await migrateWorkspaceResource({ ...input, hooks: freeSpace });
    expect(receipt.status).toBe("activated");
    await expect(readFile(path.join(input.destinationPath, "nested", "edition.jsonl"), "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("finalizes exact journal-owned destination data after a crash following activation", async () => {
    const input = await fixture(); await crashAtActivation(input, true);
    const before = (await lstat(input.destinationPath, { bigint: true })).ino;
    const receipt = await migrateWorkspaceResource({ ...input, hooks: freeSpace });
    expect(receipt.status).toBe("activated");
    expect((await lstat(input.destinationPath, { bigint: true })).ino).toBe(before);
    await expect(stat(path.join(input.destinationPath, ".spawnfile-resource-activation-provenance"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
