import { chmod, link, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareTraining } from "./prepare.js";
import { preparationFixture, imageDocker, image } from "./fixtures.test-helper.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const routes = [
  { purpose: "extraction" as const, provider: "codex-subscription" as const, model: "extract-model", maxRequests: 12 },
  { purpose: "decisions" as const, provider: "typesafe" as const, model: "judge-model", maxRequests: 20, maxSpendUsd: 1 }
];
async function setup() {
  const f = await preparationFixture(); roots.push(f.root);
  f.config.version = "spawnfile.training-container.v4";
  f.config.broker = { engine: "grok", maxRunRequests: 50, agentId: "agent:a", model: "grok-4.6", reasoningEffort: "low",
    architecture: "arm64", limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, realmVolume: "realm", bootstrap: "broker-auth" };
  await f.put("broker-auth", "fake-subscription"); await chmod(path.join(f.root, "broker-auth"), 0o600);
  f.config.evaluatorRoutes = routes;
  f.config.evaluatorSecrets = [{ provider: "typesafe", source: "typesafe-key" }];
  await f.put("typesafe-key", "test-only-key-marker"); await f.save();
  const docker = imageDocker();
  const options = { configPath: f.configPath, context: f.context, args: f.args, dryRun: false, process: docker.process,
    timeoutMs: 30000, packageRoot: path.join(f.root, "own"), streams: { stdout() {}, stderr() {} } };
  return { ...f, docker, options };
}

it("preserves evaluator authorization and secret references through preparation and exact resume", async () => {
  const f = await setup(), logs: string[] = [], imageBytes: string[] = [];
  const scan = async (root: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await scan(file); else imageBytes.push(await readFile(file, "utf8"));
    }
  };
  const options = { ...f.options, streams: { stdout: (line: string) => logs.push(line), stderr: (line: string) => logs.push(line) },
    process: async (...args: Parameters<typeof f.options.process>) => {
      if (args[0][2] === "build") await scan(args[0].at(-1)!);
      return f.docker.process(...args);
    } };
  const result = await prepareTraining(options); if ("dryRun" in result) throw Error("actual expected");
  const launch = JSON.parse(await readFile(result.configPath, "utf8"));
  expect(launch.evaluatorRoutes, "evaluator preparation propagation guarantee").toEqual(routes);
  expect(launch.evaluatorSecrets, "evaluator secret propagation guarantee").toEqual([
    { provider: "typesafe", source: path.join(f.root, "typesafe-key") }]);
  const resumed = await prepareTraining({ ...options, args: [...f.args, "--resume"] });
  expect(resumed).toEqual({ ...result, args: [...result.args, "--resume"] });
  expect(imageBytes.length).toBeGreaterThan(0);
  expect(JSON.stringify([imageBytes, logs, launch, f.docker.calls]), "secret image and log guarantee").not.toContain("test-only-key-marker");
  f.config.evaluatorRoutes![1]!.maxRequests++; await f.save();
  const refusal = await prepareTraining({ ...options, args: [...f.args, "--resume"] }).then(() => undefined, error => error);
  expect(refusal, "evaluator resume budget guarantee").toBeInstanceOf(Error);
  expect(refusal.message).toContain("exact resume rejected");
});

it("excludes evaluator secrets from input output and every image source before Docker", async () => {
  const f = await setup();
  for (const source of ["project/Spawnfile", "settings/settings.json", "paideia/dist/src/cli/main.js", "integration/entry.ts",
    "bridge/requirements.lock", "bootstrap/start.ts", "own/dist/cli/index.js", "output/key"]) {
    const original = await readFile(path.join(f.root, source), "utf8").catch(() => undefined);
    await f.put(source, "test-only-key-marker"); f.config.evaluatorSecrets![0]!.source = source; await f.save();
    const refusal = await prepareTraining(f.options).then(() => undefined, error => error);
    if (original === undefined) await rm(path.join(f.root, source)); else await f.put(source, original);
    expect(refusal, "secret image source confinement guarantee").toBeInstanceOf(Error);
    expect(f.docker.calls, "secret image source confinement guarantee").toEqual([]);
  }
});

it("validates canonical regular evaluator leaves before preparation", async () => {
  const f = await setup(); f.config.image = { ref: image };
  f.config.evaluatorSecrets![0]!.source = "own"; await f.save();
  await expect(prepareTraining(f.options)).rejects.toThrow("regular leaf");
  expect(f.docker.calls).toEqual([]);
  await symlink(path.join(f.root, "typesafe-key"), path.join(f.root, "alias"));
  f.config.evaluatorSecrets![0]!.source = "alias"; await f.save();
  await expect(prepareTraining(f.options)).rejects.toThrow("symlink aliases");
  await expect(prepareTraining({ ...f.options, dryRun: true })).rejects.toThrow("symlink aliases");
  expect(f.docker.calls).toEqual([]);
});

it("rejects hardlinked evaluator secret aliases before image or input reads", async () => {
  const f = await setup();
  await link(path.join(f.root, "typesafe-key"), path.join(f.root, "integration/key-alias"));
  await expect(prepareTraining(f.options)).rejects.toThrow("hardlink aliases");
  await expect(prepareTraining({ ...f.options, dryRun: true })).rejects.toThrow("hardlink aliases");
  expect(f.docker.calls).toEqual([]);
});
