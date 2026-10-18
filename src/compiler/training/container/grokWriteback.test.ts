import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, dockerFixture, image } from "./fixtures.test-helper.js";
import { parseTrainingBrokerDeclaration } from "../broker/declaration.js";
import { launchTrainingContainer } from "./launch.js";

// Interpose at publication only; filesystem operations and SQLite locks stay real.
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof fs>() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const credential = (day: number) => JSON.stringify({ "https://auth.x.ai::fixture": { key: "synthetic", refresh_token: "synthetic", expires_at: `2030-01-${String(day).padStart(2, "0")}T00:00:00Z` } });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const setup = async (sharedProfile?: string) => {
  const f = await fixture(); roots.push(f.root);
  const profile = sharedProfile ?? path.join(f.root, "grok-profile"), declaration = path.join(f.root, "broker.json");
  if (!sharedProfile) await writeFile(profile, credential(1), { mode: 0o600 });
  await writeFile(declaration, JSON.stringify(parseTrainingBrokerDeclaration({
    version: "spawnfile.training-broker.v2", slots: 4, engine: "grok", agentId: "agent:a",
    model: "grok-4.6", reasoningEffort: "low", architecture: "arm64", bootstrap: profile,
    organizationUid: 2000, seccompProfileSha256: "a".repeat(64),
    limits: { maxRequests: 10, maxTokens: 10000, timeoutMs: 60000 }
  })));
  await writeFile(f.configPath, JSON.stringify({ ...f.config, version: "spawnfile.training-container.v4", slots: 4,
    broker: { engine: "grok", bootstrap: profile, declaration, realmVolume: "fixture-realm" } }));
  return { ...f, profile };
};

it.each(["success", "failure", "cancel"])("writes back after %s and the next container starts from renewed auth", async (outcome) => {
  const f = await setup(), controller = new AbortController(); let running = false;
  const streams = { stdout: vi.fn(), stderr: vi.fn() };
  const docker = dockerFixture(async (args) => {
    if (args[2] === "start") {
      if (outcome === "cancel") { running = true; controller.abort(); throw Error("cancelled"); }
      if (outcome === "failure") return { code: 2, stdout: "", stderr: "" };
    }
    if (args[4] === "{{json .State}}") return { code: 0, stdout: JSON.stringify({ Running: running, ExitCode: outcome === "failure" ? 2 : 0 }), stderr: "" };
    if (args[2] === "stop") { running = false; return { code: 0, stdout: "", stderr: "" }; }
    if (args[2] === "cp") {
      expect(running).toBe(false);
      const journal = args[3]!.endsWith("credential-journal.json");
      await writeFile(args[4]!, journal ? JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted",
        generation: 1, sourceDigest: digest(credential(1)), promotedDigest: digest(credential(2)) }) : credential(2), { mode: 0o600 });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[2] === "rm") expect(await readFile(f.profile, "utf8")).toBe(credential(2));
    return undefined;
  });
  expect(await launchTrainingContainer({ ...f, image, timeoutMs: 3000, signal: controller.signal, streams, process: docker.process }))
    .toBe(outcome === "cancel" ? 130 : outcome === "failure" ? 2 : 0);
  expect(await readFile(f.profile, "utf8")).toBe(credential(2));
  expect(JSON.stringify(streams.stdout.mock.calls)).not.toContain("synthetic");
  expect(JSON.stringify(streams.stderr.mock.calls)).not.toContain("synthetic");
  // A separate launch resolves the same profile pathname after atomic replacement.
  const next = dockerFixture(async (args, options) => {
    if (args[2] === "create") expect(await readFile(f.profile, "utf8")).toBe(credential(2));
    if (args[2] === "cp") return docker.process(args, options);
    return undefined;
  });
  expect(await launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams, process: next.process })).toBe(0);
});

it.each([2, 3])("serializes concurrent cleanup with expiry %i first, without caller retries", async (firstDay) => {
  const first = await setup(), second = await setup(first.profile), secondDay = firstDay === 2 ? 3 : 2;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const publishing = deferred(), proceed = deferred(), contended = deferred();
  const rename = fs.rename, exec = DatabaseSync.prototype.exec;
  let active = 0, maximum = 0;
  const published: string[] = [], scratch = new Set<string>();
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to !== first.profile) return rename(from, to);
    maximum = Math.max(maximum, ++active);
    try {
      published.push(await readFile(from, "utf8"));
      if (published.length === 1) { publishing.resolve(); await proceed.promise; }
      await rename(from, to);
    } finally { active--; }
  });
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    try { return exec.call(this, sql); }
    catch (error) { if ((error as { errcode?: number }).errcode === 5) contended.resolve(); throw error; }
  });
  const docker = (day: number) => dockerFixture(async (args) => {
    if (args[2] === "cp") {
      scratch.add(path.dirname(args[4]!));
      await writeFile(args[4]!, args[3]!.endsWith("credential-journal.json") ? JSON.stringify({
        version: "noopolis.daimon.broker-credential-journal.v1", state: "promoted", generation: 1,
        sourceDigest: digest(credential(1)), promotedDigest: digest(credential(day))
      }) : credential(day), { mode: 0o600 });
      return { code: 0, stdout: "", stderr: "" };
    }
    return undefined;
  });
  const a = docker(firstDay), b = docker(secondDay), streams = { stdout() {}, stderr() {} };
  const pendingFirst = launchTrainingContainer({ ...first, image, timeoutMs: 3000, streams, process: a.process });
  let pendingSecond: Promise<number> | undefined;
  try {
    await Promise.race([publishing.promise, pendingFirst.then(() => { throw Error("First cleanup skipped publication"); })]);
    pendingSecond = launchTrainingContainer({ ...second, image, timeoutMs: 3000, streams, process: b.process });
    const results = Promise.allSettled([pendingFirst, pendingSecond]);
    // Release only after SQLite positively proves the second cleanup contended.
    await Promise.race([contended.promise, pendingSecond.then(() => { throw Error("Second cleanup bypassed contention"); })]);
    expect(await readFile(first.profile, "utf8")).toBe(credential(1));
    proceed.resolve();
    expect(await results).toEqual([{ status: "fulfilled", value: 0 }, { status: "fulfilled", value: 0 }]);
    expect(maximum).toBe(1);
    expect(published).toEqual(firstDay === 2 ? [credential(2), credential(3)] : [credential(3)]);
    expect(await readFile(first.profile, "utf8")).toBe(credential(3));
    for (const value of [a, b]) expect(value.calls.filter(args => args[2] === "rm")).toHaveLength(1);
    expect(scratch.size).toBe(2);
    for (const root of scratch) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { proceed.resolve(); await Promise.allSettled([pendingFirst, ...(pendingSecond ? [pendingSecond] : [])]); }
});

it("fails visibly on export failure, preserves the profile and still removes the owned container", async () => {
  const f = await setup();
  const docker = dockerFixture(async (args) => args[2] === "cp" ? { code: 1, stdout: "", stderr: "not reported" } : undefined);
  await expect(launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: { stdout() {}, stderr() {} }, process: docker.process }))
    .rejects.toThrow("Cannot export training Grok credential");
  expect(await readFile(f.profile, "utf8")).toBe(credential(1));
  expect(docker.calls.some((args) => args[2] === "rm")).toBe(true);
});
