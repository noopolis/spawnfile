import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { trainingContainerConfigSchema } from "./contract.js";
import { launchTrainingContainer } from "./launch.js";
import { prepareTrainingContainer } from "./prepare.js";
import { trainingRunRequestMount, trainingBrokerTmpfsTargets } from "./security.js";
import { fixture, dockerFixture, image } from "./fixtures.test-helper.js";
import { trainingPreparationSchema } from "../preparation/contract.js";
import { parseTrainingBrokerDeclaration } from "../broker/declaration.js";

const brokerDeclaration = (slots = 4) => ({ version: "spawnfile.training-broker.v2", engine: "grok", agentId: "agent:a", model: "grok-4.6",
  reasoningEffort: "low", architecture: "arm64", limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, slots,
  bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth", organizationUid: 2000, seccompProfileSha256: "a".repeat(64) });
const configs = () => {
  const base = { version: "spawnfile.training-container.v4", dockerContext: "local", auth: [],
    inputs: [{ source: "/host/project", destination: "/run/training/inputs/project" }],
    output: { source: "/host/output", destination: "/run/training/output" } };
  const broker = { engine: "grok", realmVolume: "realm", bootstrap: "/host/auth", declaration: "/host/broker.json" };
  return { launch: { ...base, broker }, preparation: { ...base,
    inputs: [{ id: "project", ...base.inputs[0] }], image: { ref: image }, integration: { settings: { input: "project", path: "." } },
    broker: { ...brokerDeclaration(), version: undefined, slots: undefined, organizationUid: undefined, seccompProfileSha256: undefined, realmVolume: "realm" }
  } };
};
it("defaults v4 to four slots, accepts 1..8, and explicitly refuses legacy v3", () => {
  const { launch, preparation } = configs();
  const { version: _version, slots: _slots, organizationUid: _uid, seccompProfileSha256: _sha, ...broker } = preparation.broker;
  const authoring = { ...preparation, broker };
  expect(trainingContainerConfigSchema.parse(launch).slots).toBe(4);
  expect(trainingPreparationSchema.parse(authoring).slots).toBe(4);
  expect(parseTrainingBrokerDeclaration({ ...brokerDeclaration(), slots: undefined }).slots).toBe(4);
  for (const slots of [0, 9, -1, 1.5, "4", null]) {
    expect(() => trainingContainerConfigSchema.parse({ ...launch, slots })).toThrow();
    expect(() => trainingPreparationSchema.parse({ ...authoring, slots })).toThrow();
    expect(() => parseTrainingBrokerDeclaration({ ...brokerDeclaration(), slots })).toThrow();
  }
  for (const slots of [1, 8]) {
    expect(trainingContainerConfigSchema.parse({ ...launch, slots }).slots).toBe(slots);
    expect(trainingPreparationSchema.parse({ ...authoring, slots }).slots).toBe(slots);
  }
  for (const [schema, config] of [[trainingContainerConfigSchema, launch], [trainingPreparationSchema, authoring]] as const)
    expect(() => schema.parse({ ...config, version: "spawnfile.training-container.v3" })).toThrow(/migrate/);
});

it("mounts four slot roots and the exact read-only descriptor document during launch", async () => {
  const f = await fixture();
  await chmod(path.join(f.root, "auth-leaf"), 0o600);
  const declaration = path.join(f.root, "broker.json");
  await writeFile(declaration, JSON.stringify(brokerDeclaration()));
  await writeFile(f.configPath, JSON.stringify({ ...f.config, version: "spawnfile.training-container.v4", slots: 4,
    broker: { engine: "grok", realmVolume: "training-realm", bootstrap: path.join(f.root, "auth-leaf"), declaration } }));
  let seen = false;
  const docker = dockerFixture(async args => {
    // No refresh in this mount test: export the unchanged bootstrap after stop.
    if (args[2] === "cp") {
      if (args[3]!.endsWith("credential-journal.json")) return { code: 1, stdout: "", stderr: "" };
      await copyFile(path.join(f.root, "auth-leaf"), args[4]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[2] !== "create") return undefined;
    const mount = args.find(a => a.includes("dst=/run/paideia/slots.json"))!;
    expect(args).toContain(trainingRunRequestMount(f.output, ["--out", "/run/training/output"]));
    expect(mount).toContain(",readonly");
    const source = /src=([^,]+)/.exec(mount)![1]!;
    const document = JSON.parse(await readFile(source, "utf8"));
    expect(args).not.toContain("--concurrency");
    expect(document.schema).toBe("spawnfile.training-slots.v1");
    expect(document.slots.map((p: {index: number}) => p.index)).toEqual([0, 1, 2, 3]);
    for (let i = 0; i < 4; i++) expect(args).toContain(`/run/training/slots/${i}:rw,nosuid,nodev,size=4g,mode=0711`);
    seen = true;
    return undefined;
  });
  const status = await launchTrainingContainer({ ...f, image, timeoutMs: 5000, process: docker.process, streams: { stdout: vi.fn(), stderr: vi.fn() } });
  expect(status).toBe(0); expect(seen).toBe(true);
  expect(docker.calls.find(args => args[2] === "create")).toContain("PAIDEIA_MODEL_REQUEST_CAP=broker");
  await writeFile(declaration, JSON.stringify(brokerDeclaration(1)));
  await expect(launchTrainingContainer({ ...f, image, timeoutMs: 5000, process: docker.process,
    streams: { stdout: vi.fn(), stderr: vi.fn() } })).rejects.toThrow(/slots differ/);
});

it("retains one broker-only budget volume across container replacement and separates run directories", () => {
  const mount = trainingRunRequestMount("/host/output", ["--out", "/run/training/output/run-a"]);
  expect(trainingRunRequestMount("/host/output", ["--out", "/run/training/output/run-a", "--resume"])).toBe(mount);
  expect(trainingRunRequestMount("/host/output", ["--out", "/run/training/output/run-b"])).not.toBe(mount);
  expect(trainingRunRequestMount("/other/output", ["--out", "/run/training/output/run-a"])).not.toBe(mount);
  expect(mount).toMatch(/^type=volume,src=spawnfile-training-budget-[a-f0-9]{64},dst=\/run\/training\/request-budget$/u);
  expect(trainingBrokerTmpfsTargets().some(entry => entry.path === "/run/training/request-budget")).toBe(false);
  for (const args of [[], ["--out"], ["--out", "/one", "--out", "/two"]]) {
    expect(() => trainingRunRequestMount("/host/output", args)).toThrow(/one --out/);
  }
});

it("leaves concurrency absent for serial comparisons and validates explicit optimization controls before Docker", async () => {
  const f = await fixture();
  for (const slots of [1, 2, 4, 8]) {
    const config = { ...f.config, version: "spawnfile.training-container.v4", slots,
      broker: { engine: "grok", realmVolume: "training-realm", bootstrap: path.join(f.root, "auth-leaf"), declaration: path.join(f.root, "broker.json") } };
    expect((await prepareTrainingContainer(config, f.context, f.args)).args).not.toContain("--concurrency");
    for (const override of [["--concurrency", "1"], ["--concurrency=1"]]) {
      expect((await prepareTrainingContainer(config, f.context, [...f.args, ...override])).args.slice(-2)).toEqual(["--concurrency", "1"]);
    }
    for (const override of [["--concurrency", "0"], ["--concurrency", String(slots + 1)], ["--concurrency"],
      ["--concurrency", "1", "--concurrency=1"]]) {
      await expect(prepareTrainingContainer(config, f.context, [...f.args, ...override])).rejects.toThrow(/concurrency/);
    }
  }
});
