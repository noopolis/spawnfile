import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createDockerTargetLocalBundleBuilder } from "./dockerContainerBundleBuilder.js";
import type { ParsedContainerBundleArchive } from "./containerBundleArchive.js";
import { DockerArtifactProviderError, type DockerArtifactExecutor } from "./dockerArtifactsProvider.js";

const context = "target_1";
const base = `sha256:${"a".repeat(64)}`;
const output = `sha256:${"b".repeat(64)}`;
const tag = `spfb_${"c".repeat(58)}`;
const scratchTag = (): string => `spfb_base_${createHash("sha256").update("spawnfile.target-local-container-bundle.base-tag.v2\0", "utf8").update(`${base}\0${tag}`, "utf8").digest("hex").slice(0, 53)}`;
const labels = Object.freeze({ spawnfile_target_bundle_v1_base: base, spawnfile_target_bundle_v1_entrypoint: "main.js" });
const archive = Object.freeze({ bytes: new Uint8Array(), entries: Object.freeze([{ path: "bundle.json", bytes: Buffer.from("{}") }, { path: "main.js", bytes: Buffer.from("x") }]) }) as ParsedContainerBundleArchive;
interface Image { readonly Architecture: "amd64"; readonly Cmd: readonly string[] | null; readonly Entrypoint: readonly string[] | null; readonly Env: readonly string[] | null; readonly ExposedPorts: null; readonly Healthcheck: null; readonly Id: string; readonly Labels: Readonly<Record<string, string>> | null; readonly OnBuild: null; readonly Os: "linux"; readonly RootFSLayers: readonly string[]; readonly RootFSType: "layers"; readonly User: string | null; readonly Volumes: null; readonly WorkingDir: string | null; }
const baseImage = (changes: Partial<Image> = {}): Image => ({ Architecture: "amd64", Cmd: [], Entrypoint: null, Env: ["PATH=/usr/local/bin"], ExposedPorts: null, Healthcheck: null, Id: base, Labels: null, OnBuild: null, Os: "linux", RootFSLayers: ["sha256:layer-base"], RootFSType: "layers", User: "", Volumes: null, WorkingDir: "", ...changes });
const outputImage = (changes: Partial<Image> = {}): Image => ({ Architecture: "amd64", Cmd: null, Entrypoint: ["node", "/opt/bundle/main.js"], Env: ["PATH=/usr/local/bin"], ExposedPorts: null, Healthcheck: null, Id: output, Labels: Object.fromEntries(Object.entries(labels).reverse()), OnBuild: null, Os: "linux", RootFSLayers: ["sha256:layer-base", "sha256:layer-bundle"], RootFSType: "layers", User: "", Volumes: null, WorkingDir: "/opt/bundle", ...changes });
interface State { readonly calls: string[][]; readonly images: Map<string, Image>; buildImage?: Image; context?: Uint8Array; inspectFailure?: Error; inspectFailures?: ReadonlyMap<string, Error>; }
const fake = (state: State): DockerArtifactExecutor => async (_file, args, options) => {
  state.calls.push(args);
  if (args[2] === "image" && args[3] === "inspect") {
    const reference = args.at(-1)!;
    if (state.inspectFailure) throw state.inspectFailure;
    const targeted = state.inspectFailures?.get(reference); if (targeted) throw targeted;
    const image = state.images.get(reference); if (!image) throw new DockerArtifactProviderError("image_not_found");
    if (args[5] === "{{.Id}}") return { stderr: "", stdout: image.Id };
    expect(args[5]).toMatch(/^\[\{.*\}\]$/u);
    const { Architecture, Cmd, Entrypoint, Env, ExposedPorts, Healthcheck, Id, Labels, OnBuild, Os, RootFSLayers, RootFSType, User, Volumes, WorkingDir } = image;
    return { stderr: "", stdout: JSON.stringify([{ Architecture, Config: { Cmd, Entrypoint, Env, ExposedPorts, Healthcheck, Labels, OnBuild, User, Volumes, WorkingDir }, Id, Os, RootFSLayers, RootFSType }]) };
  }
  if (args[2] === "image" && args[3] === "tag") {
    const image = state.images.get(args[4]!); if (!image) throw new Error("missing base"); state.images.set(args[5]!, image); return { stderr: "", stdout: "" };
  }
  if (args[2] === "image" && args[3] === "rm") { state.images.delete(args[4]!); return { stderr: "", stdout: "untagged\n" }; }
  if (args[2] === "build") {
    state.context = (options as unknown as { stdin?: Uint8Array }).stdin;
    const outputTag = args[args.indexOf("--tag") + 1]!; state.images.set(outputTag, state.buildImage ?? outputImage()); return { stderr: "", stdout: "" };
  }
  throw new Error(`unexpected ${args.join(" ")}`);
};
const invoke = (state: State) => createDockerTargetLocalBundleBuilder({ context, executor: fake(state) }).build({ archive, base_image_config_digest: base, entrypoint: "main.js", gc_tag: tag, labels, platform: { architecture: "amd64", os: "linux" } });

describe("target-local bundle Docker builder", () => {
  it("builds a canonical USTAR context and removes only its exact scratch tag", async () => {
    const state: State = { calls: [], images: new Map([[base, baseImage()]]) };
    await expect(invoke(state)).resolves.toMatchObject({ config_id: output, labels });
    expect(state.calls.some((args) => args.includes("build"))).toBe(true); expect(state.calls.some((args) => args.includes("rm"))).toBe(true);
    expect([...state.images.keys()]).toEqual([base, tag]);
    const contextBytes = state.context!; expect(contextBytes.subarray(257, 265).toString()).toBe("ustar\0" + "00");
    expect(contextBytes.subarray(329, 345).every((byte) => byte === 0)).toBe(true);
    expect(Buffer.from(contextBytes).toString("utf8")).toContain("CMD []\n");
  });

  it("admits reviewed inherited defaults that its Dockerfile deterministically overrides", async () => {
    const state: State = { calls: [], images: new Map([[base, baseImage({
      Cmd: ["node"], Entrypoint: ["docker-entrypoint.sh"], WorkingDir: "/"
    })]]) };
    await expect(invoke(state)).resolves.toMatchObject({ config_id: output, labels });
    expect(state.calls.some((args) => args.includes("build"))).toBe(true);
  });

  it("normalizes Docker's null default user and workdir to empty values", async () => {
    const state: State = { calls: [], images: new Map([[base, baseImage({
      User: null, WorkingDir: null,
    })]]) };
    await expect(invoke(state)).resolves.toMatchObject({ config_id: output, labels });
  });

  it("rejects an already tagged output instead of adopting or overwriting it", async () => {
    const state: State = { calls: [], images: new Map([[base, baseImage()], [tag, outputImage()]]) };
    await expect(invoke(state)).rejects.toThrow("Target-local container bundle preparation failed");
    expect(state.calls.some((args) => args.includes("build") || args.includes("tag") || args.includes("rm"))).toBe(false);
  });

  it("does not remove a colliding scratch tag that it did not create", async () => {
    const scratch = scratchTag();
    const state: State = { calls: [], images: new Map([[base, baseImage()], [scratch, baseImage()]]) };
    await expect(invoke(state)).rejects.toThrow("Target-local container bundle preparation failed");
    expect(state.calls.some((args) => args.includes("tag") || args.includes("rm") || args.includes("build"))).toBe(false);
  });

  it("rejects an output whose environment diverges from the inspected authorized base", async () => {
    const state: State = { calls: [], images: new Map([[base, baseImage()]]), buildImage: outputImage({ Env: ["PATH=/usr/local/bin", "INJECTED=1"] }) };
    await expect(invoke(state)).rejects.toThrow("Target-local container bundle preparation failed");
    expect(state.calls.some((args) => args.includes("rm"))).toBe(true);
  });

  it.each([
    ["permission", new Error("permission denied")],
    ["timeout", new Error("timeout")],
    ["transient daemon", new Error("daemon unavailable")]
  ])("fails closed when an inspect reports %s instead of typed absence", async (_name, inspectFailure) => {
    const state: State = { calls: [], images: new Map([[base, baseImage()]]), inspectFailure };
    await expect(invoke(state)).rejects.toThrow();
    expect(state.calls.some((args) => args.includes("build") || args.includes("tag"))).toBe(false);
  });

  it.each([
    ["output", tag],
    ["scratch", scratchTag()]
  ])("does not reinterpret a transient %s-tag inspect failure as absence", async (_name, reference) => {
    const state: State = { calls: [], images: new Map([[base, baseImage()]]),
      inspectFailures: new Map([[reference, new Error("daemon unavailable")]]) };
    await expect(invoke(state)).rejects.toThrow();
    expect(state.calls.some((args) => args.includes("build") || args.includes("tag"))).toBe(false);
  });

  it.each([
    ["output", tag, "different missing image name"],
    ["output tag", tag, "different missing image tag"],
    ["scratch", scratchTag(), "different missing scratch name"],
    ["scratch tag", scratchTag(), "different missing scratch tag"]
  ])("does not authorize tag, build, or removal from a mismatched %s absence report", async (
    _name, reference, detail
  ) => {
    const state: State = { calls: [], images: new Map([[base, baseImage()]]),
      inspectFailures: new Map([[reference, new Error(detail)]]) };
    await expect(invoke(state)).rejects.toThrow();
    expect(state.calls.some((args) => args.includes("tag") || args.includes("build") || args.includes("rm"))).toBe(false);
  });

  it("does not interpret a mismatched anchor absence report as a removable missing anchor", async () => {
    const state: State = { calls: [], images: new Map([[base, baseImage()]]),
      inspectFailures: new Map([[tag, new Error("Docker reported a different missing image reference")]]) };
    const builder = createDockerTargetLocalBundleBuilder({ context, executor: fake(state) });
    await expect(builder.inspectAnchor({ gc_tag: tag, labels,
      platform: { architecture: "amd64", os: "linux" } })).rejects.toThrow();
    expect(state.calls.some((args) => args.includes("tag") || args.includes("build") || args.includes("rm"))).toBe(false);
  });

  it("fails closed on transient output and anchor inspections", async () => {
    const state: State = { calls: [], images: new Map([[base, baseImage()], [tag, outputImage()]]),
      inspectFailures: new Map([[tag, new Error("permission denied")]]) };
    const builder = createDockerTargetLocalBundleBuilder({ context, executor: fake(state) });
    await expect(builder.inspect({ config_id: output, gc_tag: tag, labels,
      platform: { architecture: "amd64", os: "linux" } })).rejects.toThrow();
    await expect(builder.inspectAnchor({ gc_tag: tag, labels,
      platform: { architecture: "amd64", os: "linux" } })).rejects.toThrow();
  });

  it("fails closed on malformed inspect output instead of classifying it as absence", async () => {
    const executor: DockerArtifactExecutor = async () => ({ stderr: "", stdout: "{}" });
    const builder = createDockerTargetLocalBundleBuilder({ context, executor });
    await expect(builder.build({ archive, base_image_config_digest: base, entrypoint: "main.js",
      gc_tag: tag, labels, platform: { architecture: "amd64", os: "linux" } })).rejects.toThrow();
  });
});
