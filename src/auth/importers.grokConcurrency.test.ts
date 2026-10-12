import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { importGrokAuth } from "./importers.js";
import { writeBackTrainingGrokCredential } from "./trainingGrokWriteback.js";
import { acquireTrainingGrokWritebackLock } from "./trainingGrokWritebackLock.js";

// Interpose only at publication; all reads, writes and SQLite locking are real.
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof fs>() }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const credential = (day: number) => JSON.stringify({ "https://auth.x.ai::fixture": {
  key: "synthetic", refresh_token: "synthetic", expires_at: `2030-01-0${day}T00:00:00Z`
} });
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const fixture = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "grok-import-race-"))); roots.push(root);
  vi.stubEnv("SPAWNFILE_HOME", path.join(root, "home"));
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "auth.json"), credential(1), { mode: 0o600 });
  const imported = await importGrokAuth("training", source);
  const profile = path.join(imported.imports.grok!.path, "auth.json");
  const candidate = path.join(root, "candidate"), journal = path.join(root, "journal");
  await fs.writeFile(candidate, credential(2), { mode: 0o600 });
  await fs.writeFile(journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1",
    state: "promoted", generation: 1, sourceDigest: digest(credential(1)), promotedDigest: digest(credential(2)) }), { mode: 0o600 });
  await fs.writeFile(path.join(source, "auth.json"), credential(3));
  return { source, profile, run: () => writeBackTrainingGrokCredential(profile, candidate, journal) };
};

it("excludes re-import between writeback validation and publication, then preserves the retried newer import", async () => {
  const f = await fixture();
  const rename = fs.rename;
  let intercepted = false;
  vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
    expect(to).toBe(f.profile);
    intercepted = true;
    await expect(importGrokAuth("training", f.source)).rejects.toThrow(/lock unavailable; retry/u);
    expect(await fs.readFile(f.profile, "utf8")).toBe(credential(1));
    await rename(from, to);
  });
  expect(await f.run()).toBe(true);
  expect(intercepted).toBe(true);
  await importGrokAuth("training", f.source);
  expect(await f.run()).toBe(false);
  expect(await fs.readFile(f.profile, "utf8")).toBe(credential(3));
});

it("keeps the same lock inode across re-import and excludes writeback and other imports until publication", async () => {
  const f = await fixture();
  const lock = path.join(`${f.profile}.training-writeback.lock`, "lock.sqlite");
  const before = await fs.stat(lock, { bigint: true });
  const old = await fs.open(f.profile, "r");
  const rename = fs.rename;
  let intercepted = false;
  vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
    expect(to).toBe(f.profile);
    intercepted = true;
    await expect(f.run()).rejects.toThrow("Training Grok credential writeback failed");
    await expect(importGrokAuth("training", f.source)).rejects.toThrow(/lock unavailable; retry/u);
    expect(await fs.readFile(f.profile, "utf8")).toBe(credential(1));
    await rename(from, to);
  });
  try {
    await importGrokAuth("training", f.source);
    expect(intercepted).toBe(true);
    const after = await fs.stat(lock, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(await old.readFile("utf8")).toBe(credential(1));
    expect(await fs.readFile(f.profile, "utf8")).toBe(credential(3));
    expect((await fs.stat(f.profile)).mode & 0o777).toBe(0o600);
    expect(await f.run()).toBe(false);
  } finally { await old.close(); }
});

it("releases the import lock on publication failure and preserves the previous credential", async () => {
  const f = await fixture();
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("synthetic publication failure"));
  await expect(importGrokAuth("training", f.source)).rejects.toThrow("synthetic publication failure");
  expect(await fs.readFile(f.profile, "utf8")).toBe(credential(1));
  const release = await acquireTrainingGrokWritebackLock(f.profile);
  release();
  await importGrokAuth("training", f.source);
  expect(await fs.readFile(f.profile, "utf8")).toBe(credential(3));
});
