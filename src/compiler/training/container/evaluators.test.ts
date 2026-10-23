import { chmod, copyFile, link, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trainingContainerConfigSchema, type TrainingContainerConfig } from "./contract.js";
import { launchTrainingContainer } from "./launch.js";
import { prepareTrainingContainer } from "./prepare.js";
import { fixture, dockerFixture, image } from "./fixtures.test-helper.js";
import { resolveTrainingGrokDenyPaths } from "../broker/registration.js";
import { prepareTrainingEvaluators } from "./evaluators.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const routes: NonNullable<TrainingContainerConfig["evaluatorRoutes"]> = [
  { purpose: "extraction", provider: "codex-subscription", model: "extract-model", maxRequests: 12 },
  { purpose: "proposals", provider: "codex-subscription", model: "proposal-model", maxRequests: 4 },
  { purpose: "decisions", provider: "typesafe", model: "judge-model", maxRequests: 20, maxSpendUsd: 1 }
];
const setup = async () => { const f = await fixture(); roots.push(f.root); return f; };

it("binds evaluator receipts to each mapped run output and retains the path on resume", async () => {
  const f = await setup(), receipts: string[] = [];
  await writeFile(f.configPath, JSON.stringify({ ...f.config, evaluatorRoutes: routes }));
  for (const [run, resume] of [["run-a", false], ["run-b", false], ["run-a", true]] as const) {
    await mkdir(path.join(f.output, run), { recursive: true });
    let observed = false;
    const docker = dockerFixture(async args => {
      if (args[2] === "create") {
        const mount = args.find(arg => arg.includes("dst=/run/spawnfile-training/evaluator-routes.json"))!;
        const declaration = JSON.parse(await readFile(mount.split("src=")[1]!.split(",")[0]!, "utf8"));
        receipts.push(declaration.receiptPath);
        observed = true;
      }
      return undefined;
    });
    const args = ["--train", path.join(f.project, "train.yaml"), "--out", path.join(f.output, run), ...resume ? ["--resume"] : []];
    expect(await launchTrainingContainer({ ...f, args, image, timeoutMs: 5000, process: docker.process,
      streams: { stdout() {}, stderr() {} } })).toBe(0);
    expect(observed).toBe(true);
  }
  expect(receipts, "run-scoped evaluator receipt guarantee").toEqual([
    "/run/training/output/run-a/evaluator-requests.jsonl",
    "/run/training/output/run-b/evaluator-requests.jsonl",
    "/run/training/output/run-a/evaluator-requests.jsonl"
  ]);
});

it("refuses evaluator declarations without exactly one confined mapped output", async () => {
  const f = await setup();
  for (const args of [[], ["--out"], ["--out", f.output], ["--out", "/run/training/output/../other"],
    ["--out", "/run/training/output-a"], ["--out", "/run/training/output", "--out", "/run/training/output/run-a"]]) {
    await expect(prepareTrainingEvaluators(f.root, { evaluatorRoutes: routes }, args)).rejects.toThrow("one mapped training --out");
  }
});

it("admits only explicit finite budgeted evaluator route tuples", async () => {
  const f = await setup();
  expect(trainingContainerConfigSchema.parse({ ...f.config, evaluatorRoutes: routes }).evaluatorRoutes).toEqual(routes);
  for (const evaluatorRoutes of [[{ ...routes[0], maxRequests: 0 }], [{ ...routes[0], maxRequests: 1.1 }],
    [{ ...routes[0], maxRequests: Number.MAX_SAFE_INTEGER + 1 }], [{ ...routes[0], provider: "native-grader" }],
    [{ ...routes[0], purpose: "decisions" }], [{ ...routes[2], purpose: "proposals" }],
    [{ ...routes[2], maxSpendUsd: undefined }], [{ ...routes[2], maxSpendUsd: -1 }],
    [{ ...routes[2], maxSpendUsd: Infinity }], [{ ...routes[0], maxSpendUsd: 1 }], [{ ...routes[0], model: "invalid model" }],
    [{ ...routes[0], exempt: true }], [routes[0], routes[0]], []]) {
    expect(trainingContainerConfigSchema.safeParse({ ...f.config, evaluatorRoutes }).success,
      "evaluator route admission guarantee").toBe(false);
  }
  expect(trainingContainerConfigSchema.safeParse({ ...f.config, evaluatorRoutes: routes,
    evaluatorSecrets: [{ provider: "typesafe", source: f.config.auth[0]!.source }] }).success, "brokered evaluator secret isolation guarantee").toBe(false);
});

it("mounts protected evaluator declaration and secret references while retaining the subject broker cap", async () => {
  const f = await setup(), secret = path.join(f.root, "typesafe-key"), marker = "test-only-key-marker";
  await writeFile(secret, marker);
  await chmod(f.config.auth[0]!.source, 0o600);
  const declaration = path.join(f.root, "broker.json");
  await writeFile(declaration, JSON.stringify({ version: "spawnfile.training-broker.v2", engine: "grok", agentId: "agent:a",
    model: "grok-4.6", reasoningEffort: "low", architecture: "arm64", slots: 1,
    limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
    organizationUid: 2000, seccompProfileSha256: "a".repeat(64) }));
  await writeFile(f.configPath, JSON.stringify({ ...f.config, version: "spawnfile.training-container.v4", slots: 1,
    evaluatorRoutes: routes, evaluatorSecrets: [{ provider: "typesafe", source: secret }],
    broker: { engine: "grok", realmVolume: "realm", bootstrap: f.config.auth[0]!.source, declaration } }));
  let observed = false, validationFailure: unknown;
  const docker = dockerFixture(async args => {
    if (args[2] === "cp") {
      if (args[3]!.endsWith("credential-journal.json")) return { code: 1, stdout: "", stderr: "" };
      await copyFile(f.config.auth[0]!.source, args[4]!); return { code: 0, stdout: "", stderr: "" };
    }
    if (args[2] === "create") {
      try {
      const mount = args.find(arg => arg.includes("dst=/run/spawnfile-training/evaluator-routes.json"))!;
      expect(mount, "evaluator receipt mount guarantee").toBeTruthy();
      expect(mount).toMatch(/,readonly$/u);
      const source = mount.split("src=")[1]!.split(",")[0]!;
      expect(JSON.parse(await readFile(source, "utf8")), "evaluator declaration guarantee").toEqual({
        version: "spawnfile.training.evaluator-routes.v1", routes, receiptPath: "/run/training/output/evaluator-requests.jsonl" });
      expect((await stat(source)).mode & 0o777).toBe(0o444);
      expect(args, "subject broker cap guarantee").toContain("SPAWNFILE_TRAINING_MODEL_REQUEST_CAP=broker");
      expect(args, "evaluator env handoff guarantee").toContain("SPAWNFILE_TRAINING_EVALUATOR_ROUTES_FILE=/run/spawnfile-training/evaluator-routes.json");
      expect(args, "secret reference guarantee").toContain(`type=bind,src=${secret},dst=/run/spawnfile-training/secret-ingress/typesafe,readonly`);
      expect(args).toContain("SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE=/run/spawnfile-training/secrets/typesafe");
      expect(args.some(arg => arg.startsWith("TYPESAFE_API_KEY="))).toBe(false);
      for (const file of ["/run/spawnfile-training/evaluator-routes.json", "/run/spawnfile-training/secrets/typesafe", "/run/spawnfile-training/secret-ingress/typesafe"]) {
        expect(resolveTrainingGrokDenyPaths().some(deny => file === deny || file.startsWith(deny + "/")),
          "subject secret deny guarantee").toBe(true);
      }
      observed = true;
      } catch (error) { validationFailure = error; }
    }
    return undefined;
  });
  const streams = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await launchTrainingContainer({ ...f, image, timeoutMs: 5000, process: docker.process, streams })).toBe(0);
  if (validationFailure) throw validationFailure;
  expect(observed).toBe(true);
  expect(JSON.stringify([docker.calls, streams.stdout.mock.calls, streams.stderr.mock.calls]),
    "secret logs and environment guarantee").not.toContain(marker);
});

it("rejects evaluator secret exposure through input/output and noncanonical or directory leaves", async () => {
  const f = await setup();
  const secret = path.join(f.root, "secret"); await writeFile(secret, "test-only-key-marker");
  await symlink(secret, path.join(f.root, "alias"));
  const config = { ...f.config, version: "spawnfile.training-container.v4",
    broker: { engine: "grok", realmVolume: "realm", bootstrap: f.config.auth[0]!.source, declaration: f.configPath } };
  for (const source of [path.join(f.project, "Spawnfile"), path.join(f.output, "index.json"), f.project, path.join(f.root, "alias")]) {
    const result = await prepareTrainingContainer({ ...config, evaluatorRoutes: routes,
      evaluatorSecrets: [{ provider: "typesafe", source }] }, f.context, f.args).then(() => undefined, error => error);
    expect(result, "secret mount confinement guarantee").toBeInstanceOf(Error);
  }
});

it("rejects hardlinked secret aliases in brokered direct declarations", async () => {
  const f = await setup(), secret = path.join(f.root, "secret");
  await writeFile(secret, "test-only-key-marker");
  await link(secret, path.join(f.project, "key-alias"));
  await expect(prepareTrainingContainer({ ...f.config, version: "spawnfile.training-container.v4",
    broker: { engine: "grok", realmVolume: "realm", bootstrap: f.config.auth[0]!.source, declaration: f.configPath },
    evaluatorRoutes: routes, evaluatorSecrets: [{ provider: "typesafe", source: secret }] }, f.context, f.args)).rejects.toThrow("hardlink aliases");
});
