import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { launchTrainingContainer } from "./launch.js";
import { fixture, dockerFixture, image } from "./fixtures.test-helper.js";
import { hashJson } from "../preparation/files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const f = await fixture(); roots.push(f.root); const parent = path.join(f.root, "parent"); await mkdir(parent);
  f.config.inputs.push({ source: parent, destination: "/run/training/inputs/repair-parent" });
  await writeFile(f.configPath, JSON.stringify(f.config));
  const receipt = { version: "paideia.measurement-repair.v1", parent: { root: "/run/training/inputs/repair-parent", imageId: image,
    experimentId: "00000000-0000-4000-8000-000000000001", executionIdentity: "a".repeat(64), manifestDigest: image,
    checkpoints: { command: image, training: image, host: image, optimizer: image }, trainingIdentity: "b".repeat(64) },
  current: { imageId: image, canonicalSourceDigest: image, adapterId: "daimon-native" },
  compatibility: { version: "spawnfile.daimon-dspy-compatibility.v1", components: { compiler: image }, inputs: { input: image }, digest: image } };
  const envelope = { receipt, digest: hashJson(receipt) }, repairPath = path.join(f.root, "repair.json");
  await writeFile(repairPath, JSON.stringify(envelope)); const docker = dockerFixture();
  return { ...f, parent, envelope, repairPath, docker, options: { image, configPath: f.configPath, context: f.context,
    args: [...f.args, "--repair-context", "/run/paideia/repair.json"], repairPath, timeoutMs: 10000,
    process: docker.process, streams: { stdout() {}, stderr() {} } } };
}
it("mounts receipt and projected parent readonly while retaining verified container cleanup", async () => {
  const f = await setup(); expect(await launchTrainingContainer(f.options)).toBe(0);
  const create = f.docker.calls.find(args => args[2] === "create")!;
  expect(create).toContain(`type=bind,src=${f.parent},dst=/run/training/inputs/repair-parent,readonly`);
  expect(create).toContain(`type=bind,src=${f.repairPath},dst=/run/paideia/repair.json,readonly`);
  expect(create).toContain("--repair-context");
  expect(f.docker.calls.some(args => args[2] === "rm")).toBe(true);
});
it.each(["digest", "image", "mount", "symlink"])("rejects wrong repair %s before container operation", async kind => {
  const f = await setup();
  if (kind === "digest") f.envelope.digest = `sha256:${"f".repeat(64)}`;
  if (kind === "image") { f.envelope.receipt.current.imageId = `sha256:${"f".repeat(64)}`; f.envelope.digest = hashJson(f.envelope.receipt); }
  if (kind === "mount") { f.config.inputs.pop(); await writeFile(f.configPath, JSON.stringify(f.config)); }
  await writeFile(f.repairPath, JSON.stringify(f.envelope));
  if (kind === "symlink") { const link = path.join(f.root, "alias"); await symlink(f.repairPath, link); f.options.repairPath = link; }
  await expect(launchTrainingContainer(f.options)).rejects.toThrow();
  expect(f.docker.calls).toEqual([]);
});
