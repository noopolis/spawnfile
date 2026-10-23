import { chmod, link, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { createTrainingContext } from "../context.js";
import { prepareTraining } from "./prepare.js";
import { trainingPreparationSchema } from "./contract.js";
import { preparationFixture, imageDocker, image } from "./fixtures.test-helper.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const routes = [
  { purpose: "extraction" as const, provider: "codex-subscription" as const, model: "extract-model", maxRequests: 12 },
  { purpose: "decisions" as const, provider: "typesafe" as const, model: "judge-model", maxRequests: 20, maxSpendUsd: 1 }
];
const writeSubject = (put: (file: string, value: string) => Promise<void>, runtime = "daimon", engine = "codex",
  policy: string | null = "workspace-no-network", mode = "workspace") => put("project/Spawnfile", stringify({
  spawnfile_version: "0.1", kind: "agent", name: "author", runtime: { name: runtime,
    options: { engine, ...(policy === null ? {} : { codex_policy: policy }) } }, execution: { sandbox: { mode } }
}));
async function setup(native = false) {
  const f = await preparationFixture(); roots.push(f.root);
  f.config.version = "spawnfile.training-container.v4";
  f.config.broker = { engine: "grok", maxRunRequests: 50, agentId: "agent:a", model: "grok-4.6", reasoningEffort: "low",
    architecture: "arm64", limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, realmVolume: "realm", bootstrap: "broker-auth" };
  await f.put("broker-auth", "fake-subscription"); await chmod(path.join(f.root, "broker-auth"), 0o600);
  f.config.evaluatorRoutes = routes;
  f.config.evaluatorSecrets = [{ provider: "typesafe", source: "typesafe-key" }];
  if (native) {
    f.config.version = "spawnfile.training-container.v2";
    delete f.config.broker;
    f.config.subjectIsolation = "codex-native-sandbox";
    f.config.auth[0]!.provider = "codex";
    await writeSubject(f.put);
    Object.assign(f.context, await createTrainingContext(f.context.project.manifest, { packageVersion: "test" }));
  }
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
  for (const source of ["project/Spawnfile", "settings/settings.json", "own/dist/runtime/trainingCli.js", "integration/entry.ts",
    "own/dist/training/dspy/requirements.lock", "bootstrap/start.ts", "own/dist/cli/index.js", "output/key"]) {
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

it.each(["ref", "build"])("lowers explicit Codex isolation and evaluator references into v1 and preserves exact resume: %s", async (kind) => {
  const f = await setup(true);
  if (kind === "ref") f.config.image = { ref: image };
  await f.save();
  const result = await prepareTraining(f.options); if ("dryRun" in result) throw Error("actual expected");
  const launch = JSON.parse(await readFile(result.configPath, "utf8"));
  expect(launch.subjectIsolation, "Codex preparation isolation propagation guarantee").toBe("codex-native-sandbox");
  expect(launch.version).toBe("spawnfile.training-container.v1");
  expect(launch.broker).toBeUndefined();
  expect(launch.auth[0].provider).toBe("codex");
  expect(launch.evaluatorRoutes).toEqual(routes);
  expect(launch.evaluatorSecrets).toEqual([{ provider: "typesafe", source: path.join(f.root, "typesafe-key") }]);
  expect(result.context.agent).toEqual(f.context.agent);
  expect(f.docker.calls.some(call => call[2] === "build")).toBe(kind === "build");
  expect(JSON.stringify([launch, f.docker.calls])).not.toContain("test-only-key-marker");
  expect(await prepareTraining({ ...f.options, args: [...f.args, "--resume"] })).toEqual({ ...result, args: [...result.args, "--resume"] });
  delete f.config.subjectIsolation; delete f.config.evaluatorSecrets; await f.save();
  await expect(prepareTraining({ ...f.options, args: [...f.args, "--resume"] })).rejects.toThrow("exact resume rejected");
});

it.each(["ref", "build"])("refuses mismatched Codex preparation subjects before Docker: %s", async (kind) => {
  const f = await setup(true);
  if (kind === "ref") f.config.image = { ref: image };
  await f.save();
  for (const [runtime, engine, policy, mode] of [
    ["daimon", "grok", "workspace-no-network", "workspace"],
    ["pi", "codex", "workspace-no-network", "workspace"],
    ["daimon", "codex", null, "workspace"],
    ["daimon", "codex", "workspace-no-network", "unrestricted"]
  ] as const) {
    await writeSubject(f.put, runtime, engine, policy, mode);
    for (const dryRun of [false, true]) {
      const refusal = await prepareTraining({ ...f.options, dryRun })
        .then(() => undefined, error => error);
      expect(refusal, "Codex preparation subject admission guarantee").toBeInstanceOf(Error);
      expect(refusal.message, "Codex preparation subject admission guarantee").toContain("strict codex_policy: workspace-no-network");
      expect(f.docker.calls, "Codex preparation pre-Docker guarantee").toEqual([]);
    }
  }
});

it("admits non-broker preparation secrets only with explicit Codex isolation and a TypeSafe route", async () => {
  const f = await setup(true);
  expect(trainingPreparationSchema.safeParse(f.config).success).toBe(true);
  expect(trainingPreparationSchema.safeParse({ ...f.config, subjectIsolation: undefined }).success,
    "Codex preparation secret admission guarantee").toBe(false);
  for (const config of [{ ...f.config, evaluatorRoutes: [routes[0]] },
    { ...f.config, evaluatorRoutes: undefined, evaluatorSecrets: undefined },
    { ...f.config, version: "spawnfile.training-container.v4", broker: { engine: "grok", maxRunRequests: 50,
      agentId: "agent:a", model: "grok-4.6", reasoningEffort: "low", architecture: "arm64",
      limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, realmVolume: "realm", bootstrap: "broker-auth" } }
  ]) expect(trainingPreparationSchema.safeParse(config).success).toBe(false);
});

it("rejects hardlinked and symlinked Codex evaluator leaves even in preparation dry-run", async () => {
  const f = await setup(true);
  await symlink(path.join(f.root, "typesafe-key"), path.join(f.root, "alias"));
  f.config.evaluatorSecrets![0]!.source = "alias"; await f.save();
  await expect(prepareTraining({ ...f.options, dryRun: true })).rejects.toThrow("symlink aliases");
  f.config.evaluatorSecrets![0]!.source = "typesafe-key"; await f.save();
  await link(path.join(f.root, "typesafe-key"), path.join(f.root, "integration/key-alias"));
  await expect(prepareTraining({ ...f.options, dryRun: true })).rejects.toThrow("hardlink aliases");
  await expect(prepareTraining(f.options)).rejects.toThrow("hardlink aliases");
  expect(f.docker.calls).toEqual([]);
});
