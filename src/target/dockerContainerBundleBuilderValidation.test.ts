import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { createDockerTargetLocalBundleBuilder } from "./dockerContainerBundleBuilder.js";
import { DockerArtifactProviderError, type DockerArtifactExecutor } from "./dockerArtifactsProvider.js";
import { selectTarget } from "./dockerTarget.js";

const context = "target_1";
const base = `sha256:${"a".repeat(64)}`;
const output = `sha256:${"b".repeat(64)}`;
const tag = `spfb_${"c".repeat(58)}`;
const platform = { architecture: "amd64" as const, os: "linux" as const };
const labels = Object.freeze({ spawnfile_target_bundle_v1_base: base, spawnfile_target_bundle_v1_entrypoint: "main.js" });

type Projection = Record<string, unknown> & { Config: Record<string, unknown> };
const projection = (id: string, config: Record<string, unknown>, changes: Record<string, unknown> = {}): Projection => ({
  Architecture: "amd64",
  Config: {
    Cmd: null,
    Entrypoint: ["node", "/opt/bundle/main.js"],
    Env: ["PATH=/usr/local/bin"],
    ExposedPorts: null,
    Healthcheck: null,
    Labels: labels,
    OnBuild: null,
    User: "",
    Volumes: null,
    WorkingDir: "/opt/bundle",
    ...config,
  },
  Id: id,
  Os: "linux",
  RootFSLayers: ["sha256:layer-base", "sha256:layer-bundle"],
  RootFSType: "layers",
  ...changes,
}) as Projection;
const baseProjection = (changes: Record<string, unknown> = {}): Projection => projection(base, {
  Cmd: [], Entrypoint: null, Labels: null, WorkingDir: "",
}, { RootFSLayers: ["sha256:layer-base"], ...changes });
const outputProjection = (changes: Record<string, unknown> = {}): Projection => projection(output, {}, changes);
const serialized = (value: unknown): string => typeof value === "string" ? value : JSON.stringify([value]);
const executorFor = (images: ReadonlyMap<string, unknown>): DockerArtifactExecutor => async (_file, args) => {
  const reference = args.at(-1)!;
  const value = images.get(reference);
  if (value instanceof Error) throw value;
  if (value === undefined) throw new DockerArtifactProviderError("image_not_found");
  return { stderr: "", stdout: serialized(value) };
};
const inspect = (images: ReadonlyMap<string, unknown>, expectedLabels: Readonly<Record<string, string>> = labels) => createDockerTargetLocalBundleBuilder({
  context,
  executor: executorFor(images),
}).inspect({ config_id: output, gc_tag: tag, labels: expectedLabels, platform });

describe("target-local bundle Docker builder validation", () => {
  it("rejects malformed constructor and bounded executor results", async () => {
    const noop: DockerArtifactExecutor = async () => ({ stderr: "", stdout: "" });
    expect(() => createDockerTargetLocalBundleBuilder({ context: "BAD", executor: noop })).toThrow("Target-local container bundle preparation failed");
    expect(() => createDockerTargetLocalBundleBuilder({ context, executor: null as never })).toThrow("Target-local container bundle preparation failed");

    const badResults: unknown[] = [
      null,
      { stderr: "", stdout: "x".repeat(65_537) },
      { stderr: "x".repeat(65_537), stdout: "[]" },
    ];
    for (const result of badResults) {
      const builder = createDockerTargetLocalBundleBuilder({ context, executor: async () => result as never });
      await expect(builder.inspectAnchor({ gc_tag: tag, labels, platform })).rejects.toThrow("Target-local container bundle preparation failed");
    }
  });

  it("rejects every malformed Docker inspect projection boundary", async () => {
    const malformed: unknown[] = [
      "{",
      {},
      [],
      [outputProjection(), outputProjection()],
      [null],
      [{ ...outputProjection(), Unexpected: true }],
      [{ ...outputProjection(), Config: null }],
      [{ ...outputProjection(), Config: [] }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, Labels: "bad" } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, Labels: { bad: 1 } } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, Entrypoint: "node" } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, Entrypoint: ["node", 1] } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, Cmd: "bad" } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, Env: "bad" } }],
      [{ ...outputProjection(), RootFSLayers: "bad" }],
      [{ ...outputProjection(), RootFSLayers: [] }],
      [{ ...outputProjection(), Id: "bad" }],
      [{ ...outputProjection(), RootFSType: "other" }],
      [{ ...outputProjection(), Architecture: "s390x" }],
      [{ ...outputProjection(), Os: "windows" }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, User: 1 } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, WorkingDir: 1 } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, OnBuild: [] } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, Volumes: {} } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, ExposedPorts: {} } }],
      [{ ...outputProjection(), Config: { ...outputProjection().Config, Healthcheck: {} } }],
    ];

    for (const [index, value] of malformed.entries()) {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      const builder = createDockerTargetLocalBundleBuilder({ context, executor: async () => ({ stderr: "", stdout: raw }) });
      await expect(builder.inspectAnchor({ gc_tag: tag, labels, platform }), `projection ${index + 1}`)
        .rejects.toThrow("Target-local container bundle preparation failed");
    }
  });

  it("returns null for absent, unsafe, or nonidentical inspect correlations", async () => {
    await expect(inspect(new Map([[tag, outputProjection()]]), {})).resolves.toBeNull();
    await expect(inspect(new Map([[tag, outputProjection()], [base, baseProjection({ Architecture: "arm64" })]]))).resolves.toBeNull();
    await expect(inspect(new Map([[tag, outputProjection()], [base, baseProjection({ Config: { ...baseProjection().Config, Labels: { hostile: "yes" } } })]]))).resolves.toBeNull();
    await expect(inspect(new Map<string, unknown>([[tag, outputProjection()], [base, baseProjection()], [output, new DockerArtifactProviderError("image_not_found")]]))).resolves.toBeNull();
    await expect(inspect(new Map([[tag, outputProjection({ Id: `sha256:${"d".repeat(64)}` })], [base, baseProjection()], [output, outputProjection()]]))).resolves.toBeNull();
    await expect(inspect(new Map([[tag, outputProjection()], [base, baseProjection()], [output, outputProjection({ Config: { ...outputProjection().Config, Entrypoint: ["node", "/wrong"] } })]]))).resolves.toBeNull();
  });

  it("attests the selected target and a nonempty daemon identity", async () => {
    const endpoint = "unix:///var/run/docker.sock";
    const selected = await selectTarget({ context, execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) }) });
    const requested = { fingerprint: selected.fingerprint, handle: selected.handle };
    const make = (info: string): DockerArtifactExecutor => async (_file, args) => {
      if (args[0] === "context") return { stderr: "", stdout: JSON.stringify(endpoint) };
      if (args[2] === "info") return { stderr: "", stdout: info };
      throw new Error("unexpected command");
    };
    const builder = createDockerTargetLocalBundleBuilder({ context, executor: make(JSON.stringify("daemon-one")) });
    await expect(builder.attestTarget({ selected_target: requested })).resolves.toEqual({ daemon_epoch: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) });
    await expect(builder.attestTarget({ selected_target: { ...requested, fingerprint: `sha256:${"0".repeat(32)}` } })).resolves.toBeNull();

    for (const info of ["{", "null", "7", "\"\""]) {
      const invalid = createDockerTargetLocalBundleBuilder({ context, executor: make(info) });
      await expect(invalid.attestTarget({ selected_target: requested })).resolves.toBeNull();
    }
  });
});
