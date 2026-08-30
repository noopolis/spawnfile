import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  DockerArtifactProviderError,
  type DockerArtifactExecutor,
} from "../target/dockerArtifactsProvider.js";
import { EVIDENCE_EXPORT_HELPER_ENV } from "../target/evidenceExportProvider.js";

import { prepareEvidenceExportHelper, resolvePreparedEvidenceHelperImage } from "./preparedBuilder.js";

const roots: string[] = [];
const digest = (value: string): `sha256:${string}` => `sha256:${value.repeat(64)}`;
const base = digest("a");
const helper = digest("b");
const drift = digest("c");
interface Image { readonly config: `sha256:${string}`; readonly helper: boolean; }
interface State {
  buildOutput?: string;
  readonly calls: string[][];
  readonly images: Map<string, Image>;
  buildConfig?: `sha256:${string}`;
  endpoint?: string;
  helperConfig?: Readonly<Record<string, unknown>>;
  helperCmd?: unknown;
  helperEnv?: unknown;
  implicitEndpoint?: string;
}

const helperConfigKeys = [
  "Cmd", "Entrypoint", "Env", "ExposedPorts", "Healthcheck", "Labels", "User", "Volumes",
] as const;

const docker = (state: State): DockerArtifactExecutor => async (_file, args, options) => {
  state.calls.push([...args]); const command = args.slice(2);
  if (command[0] === "context") {
    const endpoint = command[2] === "local_dev"
      ? state.endpoint
      : state.implicitEndpoint ?? state.endpoint;
    return { stderr: "", stdout: JSON.stringify(endpoint ?? "unix:///tmp/docker.sock") };
  }
  if (command[0] === "info") return { stderr: "", stdout: JSON.stringify({
    Architecture: "arm64", DockerRootDir: "/var/lib/docker", OSType: "linux", ServerVersion: "27.0",
  }) };
  if (command[0] === "image" && command[1] === "inspect") {
    const image = state.images.get(command[2]!);
    if (!image) throw new DockerArtifactProviderError("image_not_found");
    if (command[4]!.includes("Config")) {
      const configured = state.helperConfig ?? {
        Cmd: Object.hasOwn(state, "helperCmd") ? state.helperCmd : [],
        Entrypoint: ["/bin/spawnfile-export-helper"],
        Env: Object.hasOwn(state, "helperEnv") ? state.helperEnv : EVIDENCE_EXPORT_HELPER_ENV,
        ExposedPorts: null,
        Healthcheck: null, Labels: { "spawnfile.target.evidence-export.helper-contract": "v1" },
        User: "65534:65534", Volumes: null,
      };
      const projected = Object.fromEntries(helperConfigKeys.map((key) => [
        key, Object.hasOwn(configured, key) ? configured[key] : null,
      ]));
      return { stderr: "", stdout: JSON.stringify([{
        Architecture: "arm64", Config: image.helper ? projected : {}, Id: image.config, Os: "linux",
      }]) };
    }
    return { stderr: "", stdout: JSON.stringify([{ Architecture: "arm64", Id: image.config, Os: "linux" }]) };
  }
  if (command[0] === "build") {
    const produced = state.buildConfig ?? helper;
    state.images.set(produced, { config: produced, helper: true });
    expect(options).toMatchObject({ timeout: 120_000 });
    expect(command).toContain("--network=none"); expect(command).toContain("--pull=false");
    expect(command).not.toContain("--tag");
    return { stderr: "", stdout: state.buildOutput ?? `${produced}\n` };
  }
  throw new Error(`unexpected ${args.join(" ")}`);
};
const fixture = async (changes: Partial<State> = {}) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prepared-helper-"))); roots.push(root);
  const state: State = { calls: [], images: new Map([["node:22-bookworm-slim", { config: base, helper: false }]]), ...changes };
  return { input: { baseImage: "node:22-bookworm-slim", context: "local_dev", executor: docker(state), privateRoot: path.join(root, "state") }, root, state };
};
const builds = (state: State): number => state.calls.filter((args) => args.includes("build")).length;
const completionConfig = async (privateRoot: string): Promise<string> => {
  const complete = (await readdir(privateRoot)).find((name) => name.endsWith(".complete.json"));
  return JSON.parse(await readFile(path.join(privateRoot, complete!), "utf8")).accepted_image_config_digest;
};
const legacyReservationTag = async (privateRoot: string): Promise<string> => {
  const pending = (await readdir(privateRoot)).find((name) => /^[a-f0-9]{64}\.pending\.json$/u.test(name));
  if (!pending) throw new Error("missing test reservation");
  return `spawnfile-local/evidence-export-helper:tx-${pending.slice(0, 32)}`;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

describe("Spawnfile-owned prepared evidence helper", () => {
  it("binds the receipt to an immutable fsynced accepted config completion", async () => {
    const value = await fixture(); const receipt = await prepareEvidenceExportHelper(value.input);
    expect(receipt).toEqual({ digest: expect.stringMatching(/^sha256:/u), handle: expect.stringMatching(/^opaque_/u),
      version: "spawnfile.target-evidence-export-helper.prepared.v1" });
    const completion = (await readdir(value.input.privateRoot)).find((name) => name.endsWith(".complete.json"));
    const stored = JSON.parse(await readFile(path.join(value.input.privateRoot, completion!), "utf8"));
    expect(stored.accepted_image_config_digest).toBe(helper); expect(stored.receipt).toEqual(receipt);
    expect(await resolvePreparedEvidenceHelperImage(value.input, receipt)).toEqual({ configDigest: helper, imageReference: helper });
  });

  it("projects every Config key safely while rejecting hostile optional values", async () => {
    const required = {
      Entrypoint: ["/bin/spawnfile-export-helper"], Env: EVIDENCE_EXPORT_HELPER_ENV,
      Labels: { "spawnfile.target.evidence-export.helper-contract": "v1" }, User: "65534:65534",
    };
    const value = await fixture({ helperConfig: required });
    await expect(prepareEvidenceExportHelper(value.input)).resolves.toMatchObject({
      version: "spawnfile.target-evidence-export-helper.prepared.v1",
    });
    const format = value.state.calls.find((args) => args[2] === "image"
      && args[3] === "inspect" && args[4] === helper && args[5] === "--format")?.[6];
    for (const key of helperConfigKeys) {
      expect(format).toContain(`{{json (index .Config "${key}")}}`);
      expect(format).not.toContain(`{{json .Config.${key}}}`);
    }
    const hostile = await fixture({ helperConfig: { ...required, Volumes: { "/secret": {} } } });
    await expect(prepareEvidenceExportHelper(hostile.input))
      .rejects.toThrow("Prepared evidence-export helper failed");
  });

  it.each([
    ["null", null],
    ["empty", []],
    ["duplicate", [...EVIDENCE_EXPORT_HELPER_ENV, ...EVIDENCE_EXPORT_HELPER_ENV]],
    ["addition", [...EVIDENCE_EXPORT_HELPER_ENV, "HOME=/bad"]],
    ["drift", ["PATH=/bad"]],
    ["secret", ["TOKEN=private"]],
  ])("rejects hostile helper environment projection: %s", async (_name, helperEnv) => {
    const value = await fixture({ helperEnv });
    await expect(prepareEvidenceExportHelper(value.input))
      .rejects.toThrow("Prepared evidence-export helper failed");
    expect((await readdir(value.input.privateRoot)).some((name) => name.endsWith(".complete.json")))
      .toBe(false);
  });

  it("converges concurrent identical calls on one deterministic pending reservation and build", async () => {
    const value = await fixture();
    const [left, right] = await Promise.all([prepareEvidenceExportHelper(value.input), prepareEvidenceExportHelper(value.input)]);
    expect(left).toEqual(right); expect(builds(value.state)).toBe(1);
    expect(value.state.calls.find((args) => args.includes("build"))?.slice(2)).not.toContain("--tag");
  });

  it("rejects completed immutable-config drift without rebuilding it", async () => {
    const value = await fixture(); await prepareEvidenceExportHelper(value.input);
    value.state.images.set(helper, { config: drift, helper: true }); const prior = builds(value.state);
    await expect(prepareEvidenceExportHelper(value.input)).rejects.toThrow("Prepared evidence-export helper failed");
    expect(builds(value.state)).toBe(prior);
  });

  it("rebuilds a missing completed config and rejects a changed rebuilt identity", async () => {
    const value = await fixture(); const receipt = await prepareEvidenceExportHelper(value.input);
    value.state.images.delete(helper); await expect(prepareEvidenceExportHelper(value.input)).resolves.toEqual(receipt);
    value.state.images.delete(helper); value.state.buildConfig = drift;
    await expect(prepareEvidenceExportHelper(value.input)).rejects.toThrow("Prepared evidence-export helper failed");
  });

  it("does not adopt a malicious pretag and records only this build output", async () => {
    const value = await fixture();
    await expect(prepareEvidenceExportHelper({ ...value.input, testHooks: { afterReserve: () => {
      throw new Error("reserved");
    } } })).rejects.toThrow("reserved");
    const hostile = await legacyReservationTag(value.input.privateRoot);
    value.state.images.set(hostile, { config: drift, helper: true });
    await prepareEvidenceExportHelper(value.input);
    expect(await completionConfig(value.input.privateRoot)).toBe(helper);
    expect(value.state.images.get(hostile)).toEqual({ config: drift, helper: true });
    expect(value.state.calls.some((args) => args[4] === hostile)).toBe(false);
  });

  it("fails closed unless this build emits exactly one immutable config ID", async () => {
    const value = await fixture({ buildOutput: `${helper}\n${drift}\n` });
    await expect(prepareEvidenceExportHelper(value.input)).rejects.toThrow("Prepared evidence-export helper failed");
    expect((await readdir(value.input.privateRoot)).some((name) => name.endsWith(".complete.json"))).toBe(false);
  });

  it("does not let a tag swap after build alter completion provenance", async () => {
    const value = await fixture(); let hostile = "";
    await prepareEvidenceExportHelper({ ...value.input, testHooks: { afterBuild: async () => {
      hostile = await legacyReservationTag(value.input.privateRoot);
      value.state.images.set(hostile, { config: drift, helper: true });
    } } });
    expect(await completionConfig(value.input.privateRoot)).toBe(helper);
    expect(value.state.images.get(hostile)).toEqual({ config: drift, helper: true });
    expect(value.state.calls.some((args) => args[4] === hostile)).toBe(false);
  });

  it("recovers an interrupted uncompleted build by producing fresh provenance", async () => {
    const value = await fixture(); let hostile = "";
    await expect(prepareEvidenceExportHelper({ ...value.input, testHooks: { afterBuild: async () => {
      hostile = await legacyReservationTag(value.input.privateRoot);
      value.state.images.set(hostile, { config: drift, helper: true }); throw new Error("crash");
    } } })).rejects.toThrow("crash");
    await prepareEvidenceExportHelper(value.input);
    expect(builds(value.state)).toBe(2);
    expect(await completionConfig(value.input.privateRoot)).toBe(helper);
    expect(value.state.calls.some((args) => args[4] === hostile)).toBe(false);
  });

  it("rejects remote contexts before base pulls or image mutations", async () => {
    const value = await fixture({ endpoint: "ssh://operator@example.test" });
    await expect(prepareEvidenceExportHelper(value.input)).rejects.toThrow("Prepared evidence-export helper failed");
    expect(value.state.calls.map((args) => args.slice(2, 5))).toEqual([["context", "inspect", "local_dev"]]);
  });

  it("classifies the explicitly requested context rather than an implicit default", async () => {
    const value = await fixture({
      endpoint: "ssh://operator@example.test",
      implicitEndpoint: "unix:///tmp/default.sock",
    });
    await expect(prepareEvidenceExportHelper(value.input)).rejects.toThrow("Prepared evidence-export helper failed");
    expect(value.state.calls).toEqual([[
      "--context", "local_dev", "context", "inspect", "local_dev", "--format",
      "{{json .Endpoints.docker.Host}}",
    ]]);
  });

  it.each(["beforeReserve", "afterReserve", "beforeBuild", "afterBuild", "beforeComplete", "afterComplete", "beforeReceipt"]) (
    "recovers every durable, mutation, completion, and receipt fault (%s)", async (boundary) => {
      const value = await fixture();
      await expect(prepareEvidenceExportHelper({ ...value.input, testHooks: {
        [boundary]: () => { throw new Error("injected"); },
      } })).rejects.toThrow();
      await expect(prepareEvidenceExportHelper(value.input)).resolves.toMatchObject({ handle: expect.any(String) });
    }
  );
});
