import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import * as unavailable from "./legacyRecordingUnavailable.js";

const run = promisify(execFile);

it("removes a disabled folder from generated registration and every compatibility surface", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "spawnfile-builtin-discovery-"));
  try {
    const conventions = ["generate-builtin-adapters.ts", "generate-adapter-legacy-exports.ts"];
    const source = fileURLToPath(new URL("../../", import.meta.url));
    const scripts = path.join(root, "scripts");
    const runtime = path.join(root, "src", "runtime");
    const omitted = path.join(runtime, "absent");
    const remaining = path.join(runtime, "present");
    await Promise.all([mkdir(omitted, { recursive: true }), mkdir(remaining, { recursive: true }), mkdir(scripts)]);
    await symlink(path.join(source, "node_modules"), path.join(root, "node_modules"), "dir");
    await Promise.all(conventions.map((entry) => cp(path.join(source, "scripts", entry), path.join(scripts, entry))));
    await Promise.all([
      writeFile(path.join(root, "package.json"), '{"type":"module"}'),
      writeFile(path.join(omitted, "registration.ts"), "export const adapter = {};"),
      writeFile(path.join(remaining, "registration.ts"), "export const adapter = {};"),
      writeFile(path.join(omitted, "legacyExports.json"),
        JSON.stringify([{ from: "format", surfaces: ["Registry", "UsageLedger", "Recording"], values: ["parseExample"] }]))
    ]);

    const generate = () => run(process.execPath, ["--experimental-strip-types", path.join(scripts, conventions[0]!)]);
    const read = (file: string) => readFile(path.join(runtime, file), "utf8");
    await generate();
    expect(await read("legacyRegistry.generated.ts")).toContain('export { parseExample } from "./absent/format.js"');

    expect(await read("legacyRecording.generated.ts")).toContain('export { parseExample } from "./absent/format.js"');

    await rm(path.join(omitted, "registration.ts"));
    await generate();
    expect(await read("builtinAdapters.generated.ts")).toContain("./present/registration.js");
    expect(await read("builtinAdapters.generated.ts")).not.toContain("./absent/");
    expect(await read("legacyRegistry.generated.ts")).toContain("export {};");
    expect(await read("legacyUsageLedger.generated.ts")).toContain("export {};");
    expect(await read("legacyRecording.generated.ts")).toContain('export * from "./legacyRecordingUnavailable.js"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports an unavailable recording codec without admitting unverified history", async () => {
  const message = "legacy recording adapter is unavailable";
  expect(() => unavailable.createWakeMomentsParser()).toThrow(message);
  expect(() => unavailable.parseWakeMoments("")).toThrow(message);
  expect(() => unavailable.wakeHistoryPath("echo")).toThrow(message);
  expect(() => unavailable.snapshotHistoryPath("echo", "volume", "snapshot")).toThrow(message);
  expect(() => unavailable.isPartialSnapshot("snapshot")).toThrow(message);
  expect(() => unavailable.retainedSnapshotMode("directory", 0o700)).toThrow(message);
  expect(unavailable.snapshotManifestSchema.safeParse({ started_at: "2026-01-01T00:00:00Z", entries: {} }).success).toBe(false);

  const refuseRead = () => Promise.reject(new Error("unexpected history read"));
  const history = { bytes: refuseRead, text: refuseRead };
  await expect(unavailable.readSnapshotManifest(history, "snapshot", "volume", "snapshot")).rejects.toThrow(message);
  const exec = () => Promise.reject(new Error("unexpected exec"));
  const parser = { write: () => undefined, finish: () => ({ entries: [], errors: [] }) };
  await expect(unavailable.readRecordingJsonl(exec, "recording.jsonl", parser)).resolves.toEqual({
    entries: [], errors: [], failure: expect.stringContaining(message)
  });
});
