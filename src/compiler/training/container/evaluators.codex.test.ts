import { chmod, link, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { createTrainingContext } from "../context.js";
import { trainingContainerConfigSchema } from "./contract.js";
import { fixture, dockerFixture, image } from "./fixtures.test-helper.js";
import { launchTrainingContainer } from "./launch.js";
import { prepareTrainingContainer } from "./prepare.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const marker = "test-only-codex-evaluator-key";
const writeSubject = (project: string, runtime = "daimon", engine = "codex",
  policy: string | null = "workspace-no-network", mode = "workspace") => writeFile(path.join(project, "Spawnfile"), stringify({
  spawnfile_version: "0.1", kind: "agent", name: "a", runtime: { name: runtime,
    options: { engine, ...(policy === null ? {} : { codex_policy: policy }) } }, execution: { sandbox: { mode } }
}));
const setup = async () => {
  const f = await fixture(); roots.push(f.root);
  const secret = path.join(f.root, "typesafe-key");
  await writeFile(secret, marker); await chmod(secret, 0o600);
  const config = { ...f.config, subjectIsolation: "codex-native-sandbox",
    evaluatorRoutes: [{ purpose: "decisions", provider: "typesafe", model: "judge-model", maxRequests: 20, maxSpendUsd: 1 }],
    evaluatorSecrets: [{ provider: "typesafe", source: secret }] };
  await writeFile(f.configPath, JSON.stringify(config));
  await writeSubject(f.project);
  return { ...f, config, secret, context: await createTrainingContext(f.project, { packageVersion: "test" }) };
};

it("admits v1 evaluator secrets only with explicit Codex native isolation", async () => {
  const f = await setup();
  expect(trainingContainerConfigSchema.parse(f.config).subjectIsolation).toBe("codex-native-sandbox");
  expect(trainingContainerConfigSchema.safeParse({ ...f.config, subjectIsolation: undefined }).success,
    "Codex secret admission guarantee").toBe(false);
  for (const config of [
    { ...f.config, subjectIsolation: "other" },
    { ...f.config, evaluatorRoutes: undefined },
    { ...f.config, evaluatorSecrets: undefined, evaluatorRoutes: undefined },
    { ...f.config, evaluatorRoutes: [{ purpose: "proposals", provider: "codex-subscription", model: "model", maxRequests: 2 }] },
    { ...f.config, version: "spawnfile.training-container.v4", broker: { engine: "grok", realmVolume: "realm",
      bootstrap: f.config.auth[0]!.source, declaration: f.configPath } },
    { ...f.config, broker: { engine: "codex", realmVolume: "realm", bootstrap: f.config.auth[0]!.source, declaration: f.configPath } }
  ]) expect(trainingContainerConfigSchema.safeParse(config).success).toBe(false);
});

it("refuses mismatched Codex isolation subjects before any Docker process call", async () => {
  const f = await setup();
  for (const [runtime, engine, policy, mode] of [
    ["daimon", "grok", "workspace-no-network", "workspace"],
    ["pi", "codex", "workspace-no-network", "workspace"],
    ["daimon", "codex", null, "workspace"],
    ["daimon", "codex", "workspace-no-network", "unrestricted"]
  ] as const) {
    await writeSubject(f.project, runtime, engine, policy, mode);
    const docker = dockerFixture();
    // Keep the old strict subject's context: host graph facts must own admission.
    const refusal = await launchTrainingContainer({ ...f, image,
      timeoutMs: 5000, process: docker.process, streams: { stdout() {}, stderr() {} } }).then(() => undefined, error => error);
    expect(refusal, "Codex resolved subject admission guarantee").toBeInstanceOf(Error);
    expect(refusal.message, "Codex resolved subject admission guarantee").toContain("strict codex_policy: workspace-no-network");
    expect(docker.calls, "Codex pre-Docker admission guarantee").toEqual([]);
  }
});

it("binds the Codex evaluator leaf at the final readonly Paideia path with unchanged v1 privileges", async () => {
  const f = await setup(), before = await stat(f.secret), docker = dockerFixture();
  const streams = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await launchTrainingContainer({ ...f, image, timeoutMs: 5000, process: docker.process, streams })).toBe(0);
  const args = docker.calls.find(call => call[2] === "create")!;
  expect(args, "Codex evaluator secret mount guarantee").toContain(`type=bind,src=${f.secret},dst=/run/paideia/secrets/typesafe,readonly`);
  expect(args).toContain("PAIDEIA_TYPESAFE_SECRET_FILE=/run/paideia/secrets/typesafe");
  expect(args).toContain("PAIDEIA_EVALUATOR_ROUTES_FILE=/run/paideia/evaluator-routes.json");
  expect(args).toContain(`type=bind,src=${f.config.auth[0]!.source},dst=/run/paideia-auth/codex,readonly`);
  expect(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2)).toEqual(["--user", `${process.getuid!()}:${process.getgid!()}`]);
  expect(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
  expect(args).toContain("no-new-privileges"); expect(args).toContain("--read-only");
  expect(args[args.indexOf("--entrypoint") + 1]).toBe("/opt/training/bin/train");
  expect(args.some(arg => /secret-ingress|grok|realm|PAIDEIA_MODEL_REQUEST_CAP|TYPESAFE_API_KEY=|--cap-add/u.test(arg))).toBe(false);
  expect(JSON.stringify([docker.calls, streams.stdout.mock.calls, streams.stderr.mock.calls])).not.toContain(marker);
  const after = await stat(f.secret);
  expect([after.ino, after.mode, after.uid, after.gid, after.nlink, after.ctimeMs]).toEqual([
    before.ino, before.mode, before.uid, before.gid, before.nlink, before.ctimeMs]);
  expect(await readFile(f.secret, "utf8")).toBe(marker);
});

it("retains canonical single-link and mount-confinement checks for Codex evaluator leaves", async () => {
  const f = await setup(), alias = path.join(f.root, "alias"); await symlink(f.secret, alias);
  for (const source of [alias, f.project, path.join(f.project, "Spawnfile"), path.join(f.output, "index.json")]) {
    await expect(prepareTrainingContainer({ ...f.config, evaluatorSecrets: [{ provider: "typesafe", source }] },
      f.context, f.args)).rejects.toThrow();
  }
  await link(f.secret, path.join(f.project, "key-alias"));
  await expect(prepareTrainingContainer(f.config, f.context, f.args)).rejects.toThrow("hardlink aliases");
});

it("redacts the Codex evaluator secret source from Docker create diagnostics", async () => {
  const f = await setup();
  const docker = dockerFixture(async args => args[2] === "create" ? { code: 1, stdout: "",
    stderr: `invalid bind source ${f.secret}; auth ${f.config.auth[0]!.source}` }
    : args[2] === "inspect" ? { code: 1, stdout: "", stderr: "No container" } : undefined);
  const error = await launchTrainingContainer({ ...f, image, timeoutMs: 5000, process: docker.process,
    streams: { stdout() {}, stderr() {} } }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("invalid bind source [auth source]; auth [auth source]");
  expect((error as Error).message).not.toContain(f.secret);
  expect((error as Error).message).not.toContain(marker);
});
