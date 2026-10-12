import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, dockerFixture, image } from "./fixtures.test-helper.js";
import { launchTrainingContainer } from "./launch.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const credential = (day: number) => JSON.stringify({ "https://auth.x.ai::fixture": { key: "synthetic", refresh_token: "synthetic", expires_at: `2030-01-${String(day).padStart(2, "0")}T00:00:00Z` } });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const setup = async () => {
  const f = await fixture(); roots.push(f.root);
  const profile = path.join(f.root, "grok-profile"), declaration = path.join(f.root, "broker.json");
  await writeFile(profile, credential(1), { mode: 0o600 }); await writeFile(declaration, "{}");
  await writeFile(f.configPath, JSON.stringify({ ...f.config, version: "spawnfile.training-container.v3",
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

it("fails visibly on export failure, preserves the profile and still removes the owned container", async () => {
  const f = await setup();
  const docker = dockerFixture(async (args) => args[2] === "cp" ? { code: 1, stdout: "", stderr: "not reported" } : undefined);
  await expect(launchTrainingContainer({ ...f, image, timeoutMs: 3000, streams: { stdout() {}, stderr() {} }, process: docker.process }))
    .rejects.toThrow("Cannot export training Grok credential");
  expect(await readFile(f.profile, "utf8")).toBe(credential(1));
  expect(docker.calls.some((args) => args[2] === "rm")).toBe(true);
});
