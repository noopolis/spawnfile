import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claimTrainingPreparationScratch } from "./scratch.js";
import { leaveAbandonedScratch, startScratchOwner } from "./scratch.test-helper.js";

const roots: string[] = [];
const owners: Awaited<ReturnType<typeof startScratchOwner>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(owners.splice(0).map(owner => owner.stop()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
// `realpath`: the preparation parent is always canonical in production, and macOS `/var` is a symlink.
const temporary = async () => { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "training-scratch-"))); roots.push(root); return root; };
const digest = `sha256:${"a".repeat(64)}`;

describe("training preparation scratch", () => {
  it("creates the directory when nothing is there", async () => {
    const staging = path.join(await temporary(), "scratch");
    const lines: string[] = [];
    await claimTrainingPreparationScratch(staging, digest, line => lines.push(line));
    expect(await readdir(staging)).toEqual(["owner.json"]);
    expect(lines).toEqual([]);
  });

  it("reclaims a leftover from the same preparation and hands back an empty directory", async () => {
    const staging = path.join(await temporary(), "scratch");
    await leaveAbandonedScratch(staging, digest);
    await writeFile(path.join(staging, "state.json"), JSON.stringify({ digest, image: "sha256:b", staged: [], snapshots: [] }));
    await writeFile(path.join(staging, "launch.json"), "{}");
    const lines: string[] = [];
    await claimTrainingPreparationScratch(staging, digest, line => lines.push(line));
    expect(await readdir(staging)).toEqual(["owner.json"]);
    expect(lines[0]).toContain("Reusing the preparation scratch");
  });

  it("refuses a leftover from a different preparation and names how to clear it", async () => {
    const staging = path.join(await temporary(), "scratch");
    await mkdir(staging, { mode: 0o700 });
    await writeFile(path.join(staging, "state.json"), JSON.stringify({ digest: `sha256:${"c".repeat(64)}` }));
    await expect(claimTrainingPreparationScratch(staging, digest, () => undefined))
      .rejects.toThrow(/belongs to a different preparation .*; remove it to retry: rm -rf/u);
    expect(await readdir(staging)).toEqual(["state.json"]);
  });

  it("refuses a leftover that never recorded its identity, and never deletes it", async () => {
    const staging = path.join(await temporary(), "scratch");
    await mkdir(staging, { mode: 0o700 });
    await writeFile(path.join(staging, "half-staged"), "x");
    await expect(claimTrainingPreparationScratch(staging, digest, () => undefined))
      .rejects.toThrow(/never recorded its identity; remove it to retry: rm -rf/u);
    expect(await readdir(staging)).toEqual(["half-staged"]);
  });

  it("refuses a scratch path that is not a canonical directory", async () => {
    const root = await temporary();
    const staging = path.join(root, "scratch");
    await writeFile(staging, "not a directory");
    await expect(claimTrainingPreparationScratch(staging, digest, () => undefined)).rejects.toThrow(/not a canonical directory/u);
  });
});

it("reclaims owned partial staging after interruption, including sealed readonly directories", async () => {
  const staging = path.join(await temporary(), "scratch");
  await leaveAbandonedScratch(staging, digest, true);
  const failure = await claimTrainingPreparationScratch(staging, digest, () => undefined).then(() => undefined, error => error);
  await chmod(path.join(staging, "snapshot"), 0o700).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  expect(failure, "partial scratch recovery guarantee").toBeUndefined();
  expect(await readdir(staging), "partial scratch recovery guarantee").toEqual(["owner.json"]);
});

it("refuses a competing identical launch while the first process is actively staging", async () => {
  const staging = path.join(await temporary(), "scratch");
  const first = await startScratchOwner(staging, digest); owners.push(first);
  expect(first.ok).toBe(true);
  // Completed state must not bypass the liveness receipt either.
  await writeFile(path.join(staging, "state.json"), JSON.stringify({ digest }));
  const receipt = await readFile(path.join(staging, "owner.json"), "utf8");
  const second = await startScratchOwner(staging, digest); owners.push(second);
  expect(second.ok, "active scratch ownership guarantee").toBe(false);
  expect(second.error, "active scratch ownership guarantee").toContain("active or unverifiable owner");
  expect(await readFile(path.join(staging, "snapshot/input"), "utf8"), "active scratch ownership guarantee").toBe("sealed");
  expect(await readFile(path.join(staging, "owner.json"), "utf8"), "active scratch ownership guarantee").toBe(receipt);
});

it("serializes competing reclaimers and preserves the winning process's staging", async () => {
  const staging = path.join(await temporary(), "scratch");
  await leaveAbandonedScratch(staging, digest);
  const results = await Promise.all([startScratchOwner(staging, digest), startScratchOwner(staging, digest)]);
  owners.push(...results);
  const winners = results.filter(result => result.ok);
  expect(winners, "exclusive scratch recovery guarantee").toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(staging, "owner.json"), "utf8")).pid).toBe(winners[0]!.pid);
  expect(await readFile(path.join(staging, "snapshot/input"), "utf8")).toBe("sealed");
});

it("serializes resume against fresh reclamation without deleting the winning owner's inputs", async () => {
  const staging = path.join(await temporary(), "scratch");
  await leaveAbandonedScratch(staging, digest);
  const results = await Promise.all([startScratchOwner(staging, digest, false, "resume"), startScratchOwner(staging, digest)]);
  owners.push(...results);
  const winners = results.filter(result => result.ok);
  expect(winners).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(staging, "owner.json"), "utf8")).pid).toBe(winners[0]!.pid);
  expect(await readFile(path.join(staging, "snapshot/input"), "utf8")).toBe("sealed");
});

it("refuses an existing recovery guard without touching abandoned scratch", async () => {
  const staging = path.join(await temporary(), "scratch");
  await leaveAbandonedScratch(staging, digest);
  await mkdir(`${staging}.reclaim`);
  const refusal = await claimTrainingPreparationScratch(staging, digest, () => {}).then(() => undefined, (error: Error) => error);
  expect(refusal, "recovery exclusion guarantee").toBeInstanceOf(Error);
  expect(refusal?.message).toContain("recovery is already claimed");
  expect(await readFile(path.join(staging, "snapshot/input"), "utf8"), "recovery exclusion guarantee").toBe("sealed");
});

it.each([{}, { host: os.hostname(), pid: 0 }, { host: os.hostname(), pid: -1 },
  { host: os.hostname(), pid: 1.5 }, { host: "another-host", pid: process.pid }])(
  "preserves matching scratch with unverifiable ownership %j", async owner => {
    const staging = path.join(await temporary(), "scratch");
    await mkdir(staging);
    await writeFile(path.join(staging, "owner.json"), JSON.stringify({ digest, ...owner }));
    await writeFile(path.join(staging, "state.json"), JSON.stringify({ digest }));
    await expect(claimTrainingPreparationScratch(staging, digest, () => {})).rejects.toThrow("no verifiable local owner");
    expect(await readdir(staging)).toEqual(["owner.json", "state.json"]);
  });

it("preserves legacy matching state with no process receipt", async () => {
  const staging = path.join(await temporary(), "scratch");
  await mkdir(staging);
  await writeFile(path.join(staging, "state.json"), JSON.stringify({ digest }));
  await expect(claimTrainingPreparationScratch(staging, digest, () => {})).rejects.toThrow("no verifiable local owner");
  expect(await readdir(staging)).toEqual(["state.json"]);
});

it("requires ESRCH rather than assuming every liveness error means death", async () => {
  const staging = path.join(await temporary(), "scratch");
  await claimTrainingPreparationScratch(staging, digest, () => {});
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(Error("denied"), { code: "EPERM" }); });
  const refusal = await claimTrainingPreparationScratch(staging, digest, () => {}).then(() => undefined, (error: Error) => error);
  expect(refusal, "proven scratch death guarantee").toBeInstanceOf(Error);
  expect(refusal?.message).toContain("active or unverifiable owner");
  expect(await readdir(staging)).toEqual(["owner.json"]);
});
