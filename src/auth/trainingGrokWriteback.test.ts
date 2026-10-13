import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeBackTrainingGrokCredential } from "./trainingGrokWriteback.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const credential = (day: number) => JSON.stringify({ "https://auth.x.ai::fixture": { key: "synthetic", refresh_token: "synthetic", expires_at: `2030-01-${String(day).padStart(2, "0")}T00:00:00Z` } });
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const fixture = async (profileDay = 1, candidateDay = 2, override: Record<string, unknown> = {}) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "grok-writeback-"))); roots.push(root);
  const profile = path.join(root, "profile"), candidate = path.join(root, "candidate"), journal = path.join(root, "journal");
  await writeFile(profile, credential(profileDay), { mode: 0o600 });
  await writeFile(candidate, credential(candidateDay), { mode: 0o600 });
  await writeFile(journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted", generation: 2,
    sourceDigest: digest(credential(1)), promotedDigest: digest(credential(candidateDay)), ...override }), { mode: 0o600 });
  return { root, profile, candidate, journal, run: () => writeBackTrainingGrokCredential(profile, candidate, journal) };
};
it("atomically replaces the import, leaves an open old inode intact, and starts the next run with renewed bytes", async () => {
  const f = await fixture(), old = await open(f.profile, "r");
  try {
    expect(await f.run()).toBe(true);
    expect(await old.readFile("utf8")).toBe(credential(1));
    expect(await readFile(f.profile, "utf8")).toBe(credential(2));
    expect((await stat(f.profile)).mode & 0o777).toBe(0o600);
    expect(await f.run()).toBe(false);
    expect((await readdir(f.root)).sort()).toEqual(["candidate", "journal", "profile", "profile.training-writeback.lock"]);
  } finally { await old.close(); }
});
it.each([2, 3])("never overwrites an equal/newer profile (%i)", async (day) => {
  const f = await fixture(day);
  expect(await f.run()).toBe(false);
  expect(await readFile(f.profile, "utf8")).toBe(credential(day));
});
it.each([{ state: "stale" }, { state: "refreshing" }, { generation: -1 }, { promotedDigest: "0".repeat(64) }])("rejects unproven rotations and preserves profile: %j", async (override) => {
  const f = await fixture(1, 2, override);
  await expect(f.run()).rejects.toThrow(/writeback failed/u);
  expect(await readFile(f.profile, "utf8")).toBe(credential(1));
});
it("rejects malformed credential bytes without disclosing them", async () => {
  const f = await fixture(); await writeFile(f.journal, "synthetic-private-invalid-json");
  await expect(f.run()).rejects.toThrow("Training Grok credential writeback failed");
});
it("rejects symlink imports without modifying their target", async () => {
  const f = await fixture(); await rm(f.profile); await symlink(f.candidate, f.profile);
  await expect(f.run()).rejects.toThrow(/writeback failed/u);
  expect(await readFile(f.candidate, "utf8")).toBe(credential(2));
});
it("uses a proven next generation when rotation retains the same expiry", async () => {
  const f = await fixture(1, 1);
  const renewed = credential(1).replace('"key":"synthetic"', '"key":"synthetic-renewed"');
  await writeFile(f.candidate, renewed);
  await writeFile(f.journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted", generation: 2,
    sourceDigest: digest(credential(1)), promotedDigest: digest(renewed) }));
  expect(await f.run()).toBe(true);
  expect(await readFile(f.profile, "utf8")).toBe(renewed);
});

it("writes back two same-expiry rotations from the original profile", async () => {
  const f = await fixture(1, 1);
  const intermediate = credential(1).replaceAll("synthetic", "synthetic-intermediate");
  const renewed = credential(1).replaceAll("synthetic", "synthetic-renewed");
  await writeFile(f.candidate, renewed);
  await writeFile(f.journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted", generation: 2,
    sourceDigest: digest(intermediate), promotedDigest: digest(renewed), ancestorDigests: [digest(credential(1)), digest(intermediate)] }));
  expect(await f.run()).toBe(true);
  expect(await readFile(f.profile, "utf8")).toBe(renewed);
});
it("does not use another realm's generation to replace unrelated same-expiry auth", async () => {
  const f = await fixture(1, 1, { generation: 99, sourceDigest: "a".repeat(64), ancestorDigests: ["b".repeat(64)] });
  const renewed = credential(1).replaceAll("synthetic", "synthetic-unrelated");
  await writeFile(f.candidate, renewed);
  const journal = JSON.parse(await readFile(f.journal, "utf8"));
  journal.promotedDigest = digest(renewed);
  await writeFile(f.journal, JSON.stringify(journal));
  expect(await f.run()).toBe(false);
  expect(await readFile(f.profile, "utf8")).toBe(credential(1));
});
it("recovers a directory abandoned by the former lock implementation", async () => {
  const f = await fixture();
  await mkdir(`${f.profile}.training-writeback.lock`, { mode: 0o700 });
  expect(await f.run()).toBe(true);
  expect(await readFile(f.profile, "utf8")).toBe(credential(2));
});
it.each(["invalid", ["invalid"], Array(901).fill("a".repeat(64))])("refuses malformed ancestry", async (ancestorDigests) => {
  const f = await fixture(1, 2, { ancestorDigests });
  await expect(f.run()).rejects.toThrow(/writeback failed/u);
  expect(await readFile(f.profile, "utf8")).toBe(credential(1));
});

it("excludes concurrent realm writebacks and retains the newest expiry regardless of completion order", async () => {
  const f = await fixture(), newest = path.join(f.root, "newest"), journal = path.join(f.root, "newest-journal");
  await writeFile(newest, credential(3), { mode: 0o600 });
  await writeFile(journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted",
    generation: 1, sourceDigest: digest(credential(1)), promotedDigest: digest(credential(3)) }), { mode: 0o600 });
  const writeNewest = () => writeBackTrainingGrokCredential(f.profile, newest, journal);
  const results = await Promise.allSettled([f.run(), writeNewest()]);
  expect(results.every(result => result.status === "fulfilled")).toBe(true);
  expect(await readFile(f.profile, "utf8")).toBe(credential(3));
});

it("never rolls a same-expiry lineage back when an older slot/run snapshot finishes last", async () => {
  const f = await fixture(1, 1), intermediate = credential(1).replaceAll("synthetic", "synthetic-intermediate");
  const newest = credential(1).replaceAll("synthetic", "synthetic-newest");
  await writeFile(f.candidate, newest);
  await writeFile(f.journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted",
    generation: 2, sourceDigest: digest(intermediate), promotedDigest: digest(newest),
    ancestorDigests: [digest(credential(1)), digest(intermediate)] }));
  expect(await f.run()).toBe(true);
  await writeFile(f.candidate, intermediate);
  await writeFile(f.journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted",
    generation: 1, sourceDigest: digest(credential(1)), promotedDigest: digest(intermediate) }));
  expect(await f.run()).toBe(false);
  expect(await readFile(f.profile, "utf8")).toBe(newest);
});
