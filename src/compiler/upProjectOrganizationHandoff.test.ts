import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./buildProject.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./buildProject.js")>(), buildProject: vi.fn()
}));
vi.mock("./runProject.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./runProject.js")>(),
  createDockerRunInvocation: vi.fn(), resolveDetachedDeploymentOptions: vi.fn(), runDockerContainer: vi.fn()
}));
vi.mock("../deployment/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../deployment/index.js")>(),
  probeDockerOrganizationReadiness: vi.fn(), readDeploymentRecord: vi.fn(),
  resolveDockerDeploymentTarget: vi.fn(), writeDeploymentRecord: vi.fn(), writeDockerDeploymentRecordForRun: vi.fn(), initializeOrganizationHandoffAuthorityStore: vi.fn()
}));
vi.mock("../filesystem/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../filesystem/index.js")>(), fileExists: vi.fn()
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), rm: vi.fn()
}));

import { buildProject, type BuildProjectResult } from "./buildProject.js";
import { createDockerRunInvocation, resolveDetachedDeploymentOptions } from "./runProject.js";
import { upProject } from "./upProject.js";
import {
  probeDockerOrganizationReadiness, readDeploymentRecord, writeDeploymentRecord,
  writeDockerDeploymentRecordForRun, createOrganizationHandoff, createDockerDeploymentRecord, initializeOrganizationHandoffAuthorityStore, parseCanonicalSha256Digest, resolveDockerDeploymentTarget,
  type DeploymentRecord
} from "../deployment/index.js";
import { createCanonicalSelectedTargetReceiptBytes, createEndpointFingerprint, parseOpaqueTargetHandle } from "../target/index.js";
import { fileExists } from "../filesystem/index.js";
import { rm } from "node:fs/promises";
import type { OrganizationReadinessEvidence } from "./organizationReadyEvidence.js";

const endpoint = "ssh://operator@remote-4090";
const context = "remote_4090";
const fingerprint = createEndpointFingerprint(endpoint);
const selected = {
  fingerprint,
  handle: parseOpaqueTargetHandle(`opaque_${createHash("sha256")
    .update("spawnfile.target-resource.selected-target.v1\0", "utf8")
    .update(context, "utf8")
    .update("\0", "utf8")
    .update(fingerprint, "utf8")
    .digest("hex")}`),
  version: "spawnfile.target-resource.selected-target.v1"
} as const;
const selectedDigest = `sha256:${createHash("sha256").update(createCanonicalSelectedTargetReceiptBytes(selected), "utf8").digest("hex")}`;
const originalDockerHost = process.env.DOCKER_HOST;
const bindingDigest = `sha256:${"b".repeat(64)}`;
const attachment = "opaque_0123456789abcdef";
const deploymentLabels = {
  "com.spawnfile.compile_fingerprint": "sf1.0123456789ab", "com.spawnfile.deployment": "football",
  "com.spawnfile.project": "football", "com.spawnfile.run_id": "run-from-host",
  "com.spawnfile.unit": "football-container", "com.spawnfile.version": "0.1"
};
const runMetadata = { containerId: "1".repeat(64), deploymentLabels, imageId: `sha256:${"f".repeat(64)}` };
const beginAuthority = vi.fn(); const observeAuthority = vi.fn(); const finalizeAuthority = vi.fn(); const readMutationAuthority = vi.fn(); const disposeAuthority = vi.fn();
const targetExecFile = vi.fn(async () => ({ stderr: "", stdout: JSON.stringify(endpoint) }));

const evidence = (digest: string | null = bindingDigest): OrganizationReadinessEvidence => ({
  compileFingerprint: "sf1:0123456789ab", compileVersion: "0.1", hasExternalMoltnet: false,
  networks: [], organizationMembers: [], projectLabel: "football",
  version: "spawnfile.organization-ready-evidence.v1",
  worldBindings: digest === null ? null : {
    artifactPath: "/spawnfile/world-bindings.json", assignments: [], digest,
    schema: "simfile.world-bindings.v1"
  }
});

const buildResult = (worldBindings: string | null = bindingDigest): BuildProjectResult => ({
  imageTag: "football:latest", organizationReadinessEvidence: evidence(worldBindings),
  outputDirectory: "/tmp/spawnfile-handoff", report: {
    compile_fingerprint: "sf1:0123456789ab",
    container: {
      dockerfile: "Dockerfile", entrypoint: "entrypoint", env_example: ".env.example",
      model_secrets_required: [], ports: [], runtime_homes: [], runtime_instances: [],
      runtime_secrets_required: [], runtimes_installed: [], secrets_required: []
    }, diagnostics: [], nodes: [], root: "/tmp/project", spawnfile_version: "0.1"
  } as BuildProjectResult["report"], reportPath: "/tmp/spawnfile-handoff/spawnfile-report.json"
});

const record = (organization_handoff?: DeploymentRecord["organization_handoff"], organization_handoff_handle?: DeploymentRecord["organization_handoff_handle"]): DeploymentRecord => ({
  auth_profile: null, compile_fingerprint: "sf1:0123456789ab", created_at: "2026-07-22T00:00:00.000Z",
  manager: "docker", name: "football", output_directory: "/tmp/spawnfile-handoff", run_id: "run-from-host",
  source: { kind: "project", root: "/tmp/project" }, target: { kind: "host", value: "unix:///var/run/docker.sock" },
  units: [{ container_id: "opaque-container", container_name: "football", contains: [], id: "football-unit",
    image_id: "opaque-image", image_tag: "football:latest", kind: "container", runtime_instances: [] }],
  version: "spawnfile.deployment.v2", ...(organization_handoff ? { organization_handoff } : {}), ...(organization_handoff_handle ? { organization_handoff_handle } : {})
});

const complete = {
  descriptorDigest: `sha256:${"c".repeat(64)}`, detach: true, deploymentName: "football",
  dockerContext: context, networkAttachmentHandle: attachment, selectedTargetReceipt: selected,
  organizationHandoffRunId: "run-from-host", selectedTargetReceiptDigest: selectedDigest,
  targetExecFile, worldBindingsPath: "/tmp/authored-world-bindings.json"
};

beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "run-from-host";
  delete process.env.DOCKER_HOST;
  beginAuthority.mockResolvedValue({ created: true, pending: { pending_key: "a".repeat(64) } });
  observeAuthority.mockResolvedValue(undefined);
  readMutationAuthority.mockResolvedValue(null);
  finalizeAuthority.mockResolvedValue({ organization_handoff_handle: "opaque_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" });
  disposeAuthority.mockResolvedValue(undefined);
  vi.mocked(initializeOrganizationHandoffAuthorityStore).mockResolvedValue({
    begin: beginAuthority, dispose: disposeAuthority, finalize: finalizeAuthority,
    observeDockerMutation: observeAuthority, readDockerMutation: readMutationAuthority
  } as never);
  vi.mocked(fileExists).mockResolvedValue(false);
  vi.mocked(rm).mockResolvedValue(undefined);
  vi.mocked(resolveDockerDeploymentTarget).mockResolvedValue({ kind: "host", value: "unix:///var/run/docker.sock" });
  vi.mocked(resolveDetachedDeploymentOptions).mockImplementation(async (_output, options) => options);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NOOPOLIS_RUN_ID;
  if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = originalDockerHost;
});

describe("upProject organization handoff", () => {
  it("rejects every incomplete five-field handoff and non-detached complete input before build", async () => {
    const run = vi.fn();
    const partials = ["descriptorDigest", "organizationHandoffRunId", "selectedTargetReceipt", "selectedTargetReceiptDigest", "networkAttachmentHandle", "worldBindingsPath"]
      .map((key) => { const value = { ...complete } as Record<string, unknown>; delete value[key]; return value; })
      .concat([{ ...complete, detach: false }]);
    for (const options of partials) {
      await expect(upProject("/tmp/project", { ...options, runRunner: run })).rejects.toMatchObject({
        code: "validation_error"
      });
    }
    expect(buildProject).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(writeDockerDeploymentRecordForRun).not.toHaveBeenCalled();
    expect(probeDockerOrganizationReadiness).not.toHaveBeenCalled();
  });

  it("rejects malformed caller values before build without reflecting the opaque handle", async () => {
    const handle = "opaque_secret_handle";
    await expect(upProject("/tmp/project", { ...complete, networkAttachmentHandle: handle }))
      .rejects.toMatchObject({ code: "validation_error", message: expect.not.stringContaining(handle) });
    await expect(upProject("/tmp/project", { ...complete, selectedTargetReceiptDigest: "sha256:bad" }))
      .rejects.toMatchObject({ code: "validation_error" });
    expect(buildProject).not.toHaveBeenCalled();
  });

  it("requires one caller-authorized ambient run id before build or any authority mutation", async () => {
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    delete process.env.NOOPOLIS_RUN_ID;
    await expect(upProject("/tmp/project", { ...complete, runRunner: vi.fn() })).rejects.toMatchObject({ code: "validation_error" });
    process.env.NOOPOLIS_RUN_ID = "different-run";
    await expect(upProject("/tmp/project", { ...complete, runRunner: vi.fn() })).rejects.toMatchObject({ code: "validation_error" });
    expect(buildProject).not.toHaveBeenCalled();
    expect(beginAuthority).not.toHaveBeenCalled();
  });

  it("binds handoff to one explicit selected Docker context before build, authority, or Docker", async () => {
    const run = vi.fn();
    for (const options of [
      { ...complete, dockerContext: undefined },
      { ...complete, dockerHost: "tcp://host:2376" },
      { ...complete, targetExecFile: vi.fn(async () => ({ stderr: "", stdout: JSON.stringify("ssh://other-host") })) }
    ]) {
      await expect(upProject("/tmp/project", { ...options, runRunner: run }))
        .rejects.toMatchObject({ code: "validation_error" });
    }
    process.env.DOCKER_HOST = "tcp://ambient:2376";
    await expect(upProject("/tmp/project", { ...complete, runRunner: run }))
      .rejects.toMatchObject({ code: "validation_error" });
    delete process.env.DOCKER_HOST;
    expect(buildProject).not.toHaveBeenCalled();
    expect(initializeOrganizationHandoffAuthorityStore).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("verifies the resolved record-reused context and rejects raw-to-resolved target drift", async () => {
    vi.mocked(resolveDetachedDeploymentOptions).mockResolvedValueOnce({
      deploymentName: "football",
      dockerContext: context
    });
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    vi.mocked(createDockerRunInvocation).mockRejectedValueOnce(new Error("stop after build"));
    await expect(upProject("/tmp/project", {
      ...complete,
      dockerContext: undefined
    })).rejects.toThrow("stop after build");
    expect(targetExecFile).toHaveBeenCalledWith(
      "docker",
      ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"],
      expect.objectContaining({ timeout: 10_000 })
    );
    expect(buildProject).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    vi.mocked(resolveDetachedDeploymentOptions).mockResolvedValue({
      deploymentName: "football",
      dockerContext: "other_context"
    });
    await expect(upProject("/tmp/project", { ...complete, runRunner: vi.fn() }))
      .rejects.toMatchObject({ code: "validation_error" });
    expect(buildProject).not.toHaveBeenCalled();
    expect(initializeOrganizationHandoffAuthorityStore).not.toHaveBeenCalled();
  });

  it("fails closed without rerunning Docker when a durable reservation lacks an observed exact container", async () => {
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    vi.mocked(createDockerRunInvocation).mockResolvedValue({
      args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: true,
      deploymentName: "football", deploymentLabels, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
      imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
    });
    beginAuthority.mockResolvedValue({ created: false, pending: { pending_key: "a".repeat(64) } });
    const run = vi.fn(async () => runMetadata);
    await expect(upProject("/tmp/project", { ...complete, runRunner: run })).rejects.toThrow(/recovery is incomplete/);
    expect(run).not.toHaveBeenCalled(); expect(finalizeAuthority).not.toHaveBeenCalled();
    expect(writeDockerDeploymentRecordForRun).not.toHaveBeenCalled();
  });

  it("disposes authority even when pre-run detached env cleanup fails, preserving the cleanup error", async () => {
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    vi.mocked(createDockerRunInvocation).mockResolvedValue({
      args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: true,
      deploymentName: "football", deploymentLabels, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
      imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
    });
    beginAuthority.mockRejectedValueOnce(new Error("authority begin failed"));
    vi.mocked(rm).mockRejectedValueOnce(new Error("env unlink failed"));
    await expect(upProject("/tmp/project", { ...complete, runRunner: vi.fn() })).rejects.toThrow("env unlink failed");
    expect(disposeAuthority).toHaveBeenCalledOnce();
  });

  it("replays a durable exact observation through finalize and record without invoking Docker", async () => {
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    vi.mocked(createDockerRunInvocation).mockResolvedValue({
      args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: true,
      deploymentName: "football", deploymentLabels, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
      imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
    });
    beginAuthority.mockResolvedValue({ created: false, pending: { pending_key: "a".repeat(64) } });
    readMutationAuthority.mockResolvedValue({ container_id: runMetadata.containerId, deployment_labels: deploymentLabels, image_id: runMetadata.imageId });
    vi.mocked(writeDockerDeploymentRecordForRun).mockResolvedValue(null);
    const run = vi.fn(async () => runMetadata);
    await upProject("/tmp/project", { ...complete, runRunner: run });
    expect(run).not.toHaveBeenCalled();
    expect(finalizeAuthority).toHaveBeenCalledWith("a".repeat(64), expect.objectContaining({ containerId: runMetadata.containerId, deploymentLabels }));
    expect(writeDockerDeploymentRecordForRun).toHaveBeenCalledWith(expect.objectContaining({ runMetadata }));
  });

  it("accepts only an exact durable deployment record on post-record replay", async () => {
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    vi.mocked(createDockerRunInvocation).mockResolvedValue({
      args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: true,
      deploymentName: "football", deploymentLabels, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
      imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
    });
    const handle = "opaque_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as never;
    beginAuthority.mockResolvedValue({ created: false, pending: { pending_key: "a".repeat(64) } });
    readMutationAuthority.mockResolvedValue({ container_id: runMetadata.containerId, deployment_labels: deploymentLabels, image_id: runMetadata.imageId });
    finalizeAuthority.mockResolvedValue({ organization_handoff_handle: handle });
    vi.mocked(fileExists).mockResolvedValue(true);
    const existing = record(createOrganizationHandoff("run-from-host", {
      bindingDigest: parseCanonicalSha256Digest(bindingDigest), networkAttachmentHandle: parseOpaqueTargetHandle(attachment),
      selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
    }), handle);
    existing.units[0] = { ...existing.units[0]!, container_id: runMetadata.containerId, id: "football-container", image_id: runMetadata.imageId };
    vi.mocked(readDeploymentRecord).mockResolvedValue(existing);
    vi.mocked(writeDeploymentRecord).mockResolvedValue("/tmp/spawnfile-handoff/deployments/football.json");
    vi.mocked(probeDockerOrganizationReadiness).mockImplementation(async (input) => input.record.organization_ready!);
    const run = vi.fn(async () => runMetadata);
    await upProject("/tmp/project", { ...complete, runRunner: run });
    expect(run).not.toHaveBeenCalled(); expect(writeDockerDeploymentRecordForRun).not.toHaveBeenCalled();
    expect(resolveDockerDeploymentTarget).toHaveBeenCalledOnce();
  });

  it("replays an exported multi-member record byte-for-byte apart from mutable post-up fields", async () => {
    const result = buildResult();
    result.report.nodes = [
      { capabilities: [], diagnostics: [], id: "blue", kind: "agent", output_dir: null,
        runtime: null, runtime_ref: null, runtime_status: null, source: "/tmp/blue" },
      { capabilities: [], diagnostics: [], id: "red", kind: "agent", output_dir: null,
        runtime: null, runtime_ref: null, runtime_status: null, source: "/tmp/red" }
    ];
    if (!result.report.container) throw new Error("missing container report");
    result.report.container.moltnet = { node_plans: [], server_plans: [
      { base_url: "http://net-z", id: "net-z", mode: "managed", network_id: "net-z", rooms: [] },
      { base_url: "http://net-a", id: "net-a", mode: "managed", network_id: "net-a", rooms: [] }
    ] };
    result.report.container.runtime_instances = [
      { config_path: "z", home_path: null, id: "runtime-z", model_auth_methods: {},
        model_secrets_required: [], runtime: "pi" },
      { config_path: "a", home_path: null, id: "runtime-a", model_auth_methods: {},
        model_secrets_required: [], runtime: "pi" }
    ];
    vi.mocked(buildProject).mockResolvedValue(result);
    vi.mocked(createDockerRunInvocation).mockResolvedValue({
      args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: true,
      deploymentName: "football", deploymentLabels, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
      imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
    });
    const handle = "opaque_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as never;
    beginAuthority.mockResolvedValue({ created: false, pending: { pending_key: "a".repeat(64) } });
    readMutationAuthority.mockResolvedValue({ container_id: runMetadata.containerId, deployment_labels: deploymentLabels, image_id: runMetadata.imageId });
    finalizeAuthority.mockResolvedValue({ organization_handoff_handle: handle });
    vi.mocked(fileExists).mockResolvedValue(true);
    const existing = createDockerDeploymentRecord({
      authProfileName: null, compileFingerprint: "sf1:0123456789ab", containerName: "football", deploymentName: "football",
      imageTag: "football:latest", networkIds: ["net-z", "net-a"],
      nodes: result.report.nodes, organizationHandoff: {
        bindingDigest: parseCanonicalSha256Digest(bindingDigest), networkAttachmentHandle: parseOpaqueTargetHandle(attachment),
        selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
      }, organizationHandoffHandle: handle, outputDirectory: result.outputDirectory, projectRoot: "/tmp/project",
      runId: "run-from-host", runMetadata, runtimeInstanceIds: ["runtime-z", "runtime-a"], target: { kind: "host", value: "unix:///var/run/docker.sock" }
    });
    existing.export_index = { exported_at: "2026-07-24T00:00:00.000Z", path: "/tmp/export.json", run_id: "run-from-host" };
    vi.mocked(readDeploymentRecord).mockResolvedValue(existing);
    vi.mocked(writeDeploymentRecord).mockResolvedValue("/tmp/spawnfile-handoff/deployments/football.json");
    vi.mocked(probeDockerOrganizationReadiness).mockImplementation(async (input) => input.record.organization_ready!);
    await upProject("/tmp/project", { ...complete, runRunner: vi.fn() });
    expect(writeDockerDeploymentRecordForRun).not.toHaveBeenCalled();
  });

  const exactReplayRecord = (): DeploymentRecord => createDockerDeploymentRecord({
    authProfileName: null, compileFingerprint: "sf1:0123456789ab", containerName: "football", deploymentName: "football",
    imageTag: "football:latest", nodes: [], organizationHandoff: {
      bindingDigest: parseCanonicalSha256Digest(bindingDigest), networkAttachmentHandle: parseOpaqueTargetHandle(attachment),
      selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
    }, organizationHandoffHandle: "opaque_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as never,
    outputDirectory: "/tmp/spawnfile-handoff", projectRoot: "/tmp/project", runId: "run-from-host", runMetadata,
    runtimeInstanceIds: [], target: { kind: "host", value: "unix:///var/run/docker.sock" }
  });

  it.each([
    ["compile fingerprint", (value: DeploymentRecord) => { value.compile_fingerprint = "sf1.drift"; }],
    ["auth profile", (value: DeploymentRecord) => { value.auth_profile = "other"; }],
    ["env file", (value: DeploymentRecord) => { value.env_file = "/tmp/drift.env"; }],
    ["source", (value: DeploymentRecord) => { value.source = { kind: "project", root: "/tmp/drift" }; }],
    ["target", (value: DeploymentRecord) => { value.target = { kind: "host", value: "unix:///tmp/drift.sock" }; }],
    ["container id", (value: DeploymentRecord) => { value.units[0]!.container_id = "2".repeat(64); }],
    ["container image", (value: DeploymentRecord) => { value.units[0]!.image_id = `sha256:${"1".repeat(64)}`; }],
    ["unit contents", (value: DeploymentRecord) => { value.units[0]!.contains = [{ id: "drift", kind: "agent" }]; }],
    ["runtime instances", (value: DeploymentRecord) => { value.units[0]!.runtime_instances = ["drift-runtime"]; }],
    ["public handoff", (value: DeploymentRecord) => { value.organization_handoff = createOrganizationHandoff("other-run", {
      bindingDigest: parseCanonicalSha256Digest(bindingDigest), networkAttachmentHandle: parseOpaqueTargetHandle(attachment), selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
    }); }],
    ["private handoff handle", (value: DeploymentRecord) => { value.organization_handoff_handle = "opaque_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never; }]
  ])("rejects stable %s drift during replay before it can emit a receipt", async (_label, mutate) => {
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    vi.mocked(createDockerRunInvocation).mockResolvedValue({
      args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: true,
      deploymentName: "football", deploymentLabels, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
      imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
    });
    beginAuthority.mockResolvedValue({ created: false, pending: { pending_key: "a".repeat(64) } });
    readMutationAuthority.mockResolvedValue({ container_id: runMetadata.containerId, deployment_labels: deploymentLabels, image_id: runMetadata.imageId });
    vi.mocked(fileExists).mockResolvedValue(true);
    const existing = exactReplayRecord();
    mutate(existing);
    vi.mocked(readDeploymentRecord).mockResolvedValue(existing);
    const run = vi.fn(async () => runMetadata);
    await expect(upProject("/tmp/project", { ...complete, runRunner: run })).rejects.toMatchObject({ code: "validation_error" });
    expect(run).not.toHaveBeenCalled(); expect(writeDockerDeploymentRecordForRun).not.toHaveBeenCalled();
  });

  it("uses immutable compiled binding evidence once and preserves its handoff through B35 rewrites", async () => {
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    vi.mocked(createDockerRunInvocation).mockResolvedValue({
      args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: true,
      deploymentName: "football", deploymentLabels, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
      imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
    });
    const handoffHandle = parseOpaqueTargetHandle("opaque_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    const handoffRecord = record(undefined, handoffHandle);
    vi.mocked(writeDockerDeploymentRecordForRun).mockImplementation(async (input) => {
      handoffRecord.organization_handoff = createOrganizationHandoff(
        "run-from-host", input.organizationHandoff!
      );
      handoffRecord.organization_handoff_handle = handoffHandle;
      return "/tmp/spawnfile-handoff/deployments/football.json";
    });
    vi.mocked(readDeploymentRecord).mockResolvedValue(handoffRecord);
    vi.mocked(writeDeploymentRecord).mockResolvedValue("/tmp/spawnfile-handoff/deployments/football.json");
    vi.mocked(probeDockerOrganizationReadiness).mockImplementation(async (input) => ({
      ...input.record.organization_ready!, code: "probe_unavailable", state: "pending"
    }));

    const run = vi.fn(async () => runMetadata);
    await upProject("/tmp/project", { ...complete, runRunner: run });

    expect(buildProject).toHaveBeenCalledWith("/tmp/project", expect.objectContaining({
      worldBindingsPath: complete.worldBindingsPath
    }));
    expect(writeDockerDeploymentRecordForRun).toHaveBeenCalledTimes(1);
    expect(writeDockerDeploymentRecordForRun).toHaveBeenCalledWith(expect.objectContaining({
      organizationHandoff: expect.objectContaining({ bindingDigest, networkAttachmentHandle: attachment,
        selectedTargetReceiptDigest: selectedDigest })
    }));
    expect(writeDockerDeploymentRecordForRun).toHaveBeenCalledWith(expect.objectContaining({ organizationHandoffHandle: handoffHandle }));
    expect(beginAuthority.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]!);
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(finalizeAuthority.mock.invocationCallOrder[0]!);
    expect(finalizeAuthority.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(writeDockerDeploymentRecordForRun).mock.invocationCallOrder[0]!);
    expect(disposeAuthority).toHaveBeenCalledOnce();
    const writes = vi.mocked(writeDeploymentRecord).mock.calls.map((call) => call[1]);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.organization_handoff).toEqual(handoffRecord.organization_handoff);
    expect(writes[1]?.organization_handoff).toEqual(handoffRecord.organization_handoff);
  });

  it("rejects missing or malformed compiled binding evidence after build and before run", async () => {
    const run = vi.fn();
    for (const value of [null, "sha256:bad"]) {
      vi.mocked(buildProject).mockResolvedValueOnce(buildResult(value));
      await expect(upProject("/tmp/project", { ...complete, runRunner: run })).rejects.toMatchObject({
        code: "validation_error"
      });
    }
    expect(buildProject).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(createDockerRunInvocation).not.toHaveBeenCalled();
    expect(writeDockerDeploymentRecordForRun).not.toHaveBeenCalled();
  });

  it("preserves the same handoff across B35 ready, failed, cancelled, and pending terminal rewrites", async () => {
    const outcomes = [
      ["organization_ready", "ready"], ["topology_mismatch", "failed"],
      ["probe_cancelled", "cancelled"], ["probe_unavailable", "pending"]
    ] as const;
    for (const [code, state] of outcomes) {
      vi.clearAllMocks();
      vi.mocked(buildProject).mockResolvedValue(buildResult());
      vi.mocked(createDockerRunInvocation).mockResolvedValue({
        args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: true,
        deploymentName: "football", deploymentLabels, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
        imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
      });
      const handoffHandle = parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
      const stored = record(createOrganizationHandoff("run-from-host", {
        bindingDigest: parseCanonicalSha256Digest(bindingDigest),
        networkAttachmentHandle: parseOpaqueTargetHandle(attachment),
        selectedTargetReceiptDigest: parseCanonicalSha256Digest(selectedDigest)
      }), handoffHandle);
      vi.mocked(writeDockerDeploymentRecordForRun).mockResolvedValue("/tmp/spawnfile-handoff/deployments/football.json");
      vi.mocked(readDeploymentRecord).mockResolvedValue(stored);
      vi.mocked(writeDeploymentRecord).mockResolvedValue("/tmp/spawnfile-handoff/deployments/football.json");
      vi.mocked(probeDockerOrganizationReadiness).mockImplementation(async (input) => ({
        ...input.record.organization_ready!, code, state
      }));
      await upProject("/tmp/project", { ...complete, runRunner: async () => runMetadata });
      for (const [, written] of vi.mocked(writeDeploymentRecord).mock.calls) {
        expect(written.organization_handoff).toEqual(stored.organization_handoff);
        expect(written.organization_handoff_handle).toEqual(handoffHandle);
      }
    }
  });

  it("keeps no-input project up on its ordinary path", async () => {
    vi.mocked(buildProject).mockResolvedValue(buildResult());
    vi.mocked(createDockerRunInvocation).mockResolvedValue({
      args: [], command: "docker", containerName: "football", cwd: "/tmp/spawnfile-handoff", detach: false,
      deploymentName: null, dockerContext: null, dockerHost: null, envFilePath: "/tmp/spawnfile-handoff.env",
      imageTag: "football:latest", supportDirectory: "/tmp/spawnfile-handoff-support"
    });
    await upProject("/tmp/project", { runRunner: async () => undefined });
    expect(writeDockerDeploymentRecordForRun).not.toHaveBeenCalled();
    expect(probeDockerOrganizationReadiness).not.toHaveBeenCalled();
  });
});
