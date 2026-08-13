import { describe, expect, it, vi } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { createExistingDockerSecretSpec } from "./dockerSecretsProvider.js";
import {
  DOCKER_WORLD_SERVICE_ERROR,
  DockerWorldServiceProviderError,
  createDockerWorldServiceSpec,
  executeDockerWorldService,
  parseExpectedDockerWorldService,
  type DockerWorldServiceSpec
} from "./dockerWorldServiceProvider.js";

const h = (character: string) => parseOpaqueTargetHandle(`opaque_${character.repeat(64)}`);
const d = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const selectedTargetHandle = h("1");
const runId = "run-world-001";

const network = createDockerResourceSpec({
  kind: "data_network",
  operationHandle: h("2"),
  requestDigest: d("2"),
  runId,
  selectedTargetHandle
});
const evidence = createDockerResourceSpec({
  kind: "evidence_volume",
  operationHandle: h("3"),
  requestDigest: d("3"),
  runId,
  selectedTargetHandle
});
const secrets = createExistingDockerSecretSpec({
  bindingsHandle: h("4"),
  runId,
  selectedTargetHandle
});
const imageDigest = d("5");
const imageReference = `registry.example/world@${imageDigest}`;

const input = () => ({
  operationHandle: h("6"),
  requestDigest: d("6"),
  runId,
  selectedTargetHandle,
  imageReference,
  imageDigest,
  dataNetwork: { handle: network.resultHandle, labels: network.labels, name: network.name },
  evidenceMountPath: "/run/world/evidence",
  evidenceVolume: { handle: evidence.resultHandle, labels: evidence.labels, name: evidence.name },
  secretBindings: { handle: secrets.resultHandle, labels: secrets.labels, name: secrets.volumeName }
});

const inspection = (spec: DockerWorldServiceSpec): Record<string, unknown> => ({
  Id: "a".repeat(64),
  Name: `/${spec.containerName}`,
  Hostname: spec.containerName,
  Domainname: "",
  Image: imageReference,
  Labels: { ...spec.receiptLabels },
  NetworkMode: network.name,
  NetworkAttachmentCount: 1,
  NetworkAttachmentId: "b".repeat(64),
  NetworkAttachmentName: network.name,
  NetworkAliases: spec.networkAlias ? [spec.networkAlias] : null,
  PortBindingCount: 0,
  ExposedPortCount: 0,
  PublishAllPorts: false,
  Mounts: [
    { Type: "volume", Name: evidence.name, Destination: "/run/world/evidence", RW: true },
    { Type: "volume", Name: secrets.volumeName, Destination: "/run/spawnfile-secrets", RW: false }
  ],
  AutoRemove: false,
  Privileged: false,
  CapDrop: ["ALL"],
  CapAddCount: 0,
  DeviceCount: 0,
  DeviceRequestCount: 0,
  ExtraHostCount: 0,
  LinkCount: 0,
  BindCount: 0,
  VolumesFromCount: 0,
  DnsCount: 0,
  GroupAddCount: 0,
  PidMode: "",
  IpcMode: "none",
  Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m,mode=1777" },
  UTSMode: "",
  UsernsMode: "",
  CgroupnsMode: "private",
  ReadonlyRootfs: true,
  SecurityOpt: ["no-new-privileges=true"],
  LogType: "none",
  RestartPolicyName: "no",
  RestartMaximumRetryCount: 0,
  Status: "created"
});

describe("Docker world-service provider", () => {
  it("lowers one immutable world service to exact private, DNS-only create argv", () => {
    const spec = createDockerWorldServiceSpec(input());

    expect(spec.containerName).toBe("spfc_323a6c63fed2baa2820646f4d71d8ca4040f02a7bbf25e82b1c32dffcc");
    expect(spec.resultHandle).toBe("opaque_807c09833b689c7193d7ad22c6e5c0ffbb17304d3022bce4e3abae923bd0fb4c");
    expect(spec.receiptLabels).toEqual({
      spawnfile_world_service_v1_artifact: "af99ede80926249d725fe59902fef1ff09fb287c379a8fb8c0b0fe62552a132f",
      spawnfile_world_service_v1_evidence: "ee31dccaeb8799146002b536fe285532e27107e9bb05cc16d68a5d446410dcf6",
      spawnfile_world_service_v1_kind: "world_service",
      spawnfile_world_service_v1_network: "ncaf54b8e8956e3762df60dbbaf750684644b0a0eabaa0454a95125c7be8d059",
      spawnfile_world_service_v1_operation: "o704ca4d07d56c049ca0fdb56b4c8733d651d13f4b9899b971a65e188d49bddc",
      spawnfile_world_service_v1_run: "rea9a0a1cb6cc924e4881fd311626ee65a4a5fb10d1be63a1611617364247ab3",
      spawnfile_world_service_v1_secrets: "sac8545c0b59dd674bd72bdb28a09d1a660f98c3f4b08ca0872d4a7cd641cd65",
      spawnfile_world_service_v1_target: "t7d7c4fab765a8e951e5c0379936006713d3dd41b4386118f43bb4184feb88eb",
      spawnfile_world_service_v1_version: "v1"
    });
    expect(spec.imageReference).toBe(imageReference);
    expect(spec.createArgs).toEqual([
      "container", "create", "--pull", "never", "--name", spec.containerName,
      "--hostname", spec.containerName, "--network", network.name,
      "--restart", "no", "--privileged=false",
      "--publish-all=false", "--log-driver", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
      "--ipc", "none", "--cgroupns", "private",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=1m,mode=1777",
      ...Object.entries(spec.receiptLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--mount", `type=volume,src=${evidence.name},dst=/run/world/evidence,volume-nocopy`,
      "--mount", `type=volume,src=${secrets.volumeName},dst=/run/spawnfile-secrets,readonly,volume-nocopy`,
      imageReference
    ]);
    expect(spec.createArgs).not.toContain("--publish");
    expect(spec.createArgs).not.toContain("--env");
    expect(spec.inspectionFormat).toContain("NetworkAttachmentCount");
  });

  it("accepts only the exact immutable and isolated container projection", () => {
    const spec = createDockerWorldServiceSpec(input());
    const accepted = parseExpectedDockerWorldService(JSON.stringify([inspection(spec)]), spec);
    expect(accepted).toEqual({ containerId: "a".repeat(64), networkId: "b".repeat(64), status: "created" });
    for (const status of ["running", "exited", "paused", "restarting", "removing", "dead"] as const) {
      expect(parseExpectedDockerWorldService(JSON.stringify([{ ...inspection(spec), Status: status }]), spec))
        .toEqual({ containerId: "a".repeat(64), networkId: "b".repeat(64), status });
    }
    expect(parseExpectedDockerWorldService(JSON.stringify([{
      ...inspection(spec),
      NetworkAttachmentId: ""
    }]), spec)).toEqual({
      containerId: "a".repeat(64),
      networkId: "",
      status: "created"
    });
    expect(parseExpectedDockerWorldService(JSON.stringify([{
      ...inspection(spec),
      NetworkAttachmentId: "",
      Status: "running"
    }]), spec)).toBeNull();

    const aliasSpec = createDockerWorldServiceSpec({ ...input(), networkAlias: "world" });
    expect(parseExpectedDockerWorldService(JSON.stringify([{
      ...inspection(aliasSpec),
      NetworkAttachmentId: "",
      NetworkAliases: ["world"]
    }]), aliasSpec)).toEqual({
      containerId: "a".repeat(64),
      networkId: "",
      status: "created"
    });

    const drifts: Array<[string, (value: Record<string, unknown>) => void]> = [
      ["container id", (value) => { value.Id = "short"; }],
      ["status", (value) => { value.Status = "healthy"; }],
      ["image", (value) => { value.Image = `${imageReference}x`; }],
      ["name", (value) => { value.Name = "/other"; }],
      ["hostname", (value) => { value.Hostname = "other"; }],
      ["domain", (value) => { value.Domainname = "example"; }],
      ["labels", (value) => { (value.Labels as Record<string, unknown>).extra = "x"; }],
      ["network", (value) => { value.NetworkMode = "bridge"; }],
      ["extra network", (value) => { value.NetworkAttachmentCount = 2; }],
      ["network attachment", (value) => { value.NetworkAttachmentName = "bridge"; }],
      ["network alias", (value) => { value.NetworkAliases = ["unexpected"]; }],
      ["published port", (value) => { value.PortBindingCount = 1; }],
      ["exposed port", (value) => { value.ExposedPortCount = 1; }],
      ["publish all", (value) => { value.PublishAllPorts = true; }],
      ["extra mount", (value) => { (value.Mounts as unknown[]).push({}); }],
      ["writable secrets", (value) => { ((value.Mounts as Array<Record<string, unknown>>)[1]!).RW = true; }],
      ["read-only evidence", (value) => { ((value.Mounts as Array<Record<string, unknown>>)[0]!).RW = false; }],
      ["auto remove", (value) => { value.AutoRemove = true; }],
      ["privileged", (value) => { value.Privileged = true; }],
      ["cap add", (value) => { value.CapAddCount = 1; }],
      ["missing cap drop", (value) => { value.CapDrop = []; }],
      ["device", (value) => { value.DeviceCount = 1; }],
      ["device request", (value) => { value.DeviceRequestCount = 1; }],
      ["extra host", (value) => { value.ExtraHostCount = 1; }],
      ["link", (value) => { value.LinkCount = 1; }],
      ["bind", (value) => { value.BindCount = 1; }],
      ["volumes-from", (value) => { value.VolumesFromCount = 1; }],
      ["custom DNS", (value) => { value.DnsCount = 1; }],
      ["group add", (value) => { value.GroupAddCount = 1; }],
      ["host PID", (value) => { value.PidMode = "host"; }],
      ["shared IPC", (value) => { value.IpcMode = "host"; }],
      ["missing runtime tmpfs", (value) => { value.Tmpfs = {}; }],
      ["writable executable tmpfs", (value) => {
        value.Tmpfs = { "/tmp": "rw,nosuid,nodev,size=1m,mode=1777" };
      }],
      ["host UTS", (value) => { value.UTSMode = "host"; }],
      ["host userns", (value) => { value.UsernsMode = "host"; }],
      ["host cgroupns", (value) => { value.CgroupnsMode = "host"; }],
      ["writable root", (value) => { value.ReadonlyRootfs = false; }],
      ["security option", (value) => { value.SecurityOpt = []; }],
      ["logging", (value) => { value.LogType = "json-file"; }],
      ["restart", (value) => { value.RestartPolicyName = "always"; }],
      ["restart count", (value) => { value.RestartMaximumRetryCount = 1; }]
    ];
    for (const [name, mutate] of drifts) {
      const value = structuredClone(inspection(spec)); mutate(value);
      expect(parseExpectedDockerWorldService(JSON.stringify([value]), spec), name).toBeNull();
    }
  });

  it("rejects forged resource authorities, mutable images, hostile graphs, and malformed output", () => {
    const attempts: unknown[] = [
      { ...input(), imageReference: "registry.example/world:latest" },
      { ...input(), imageDigest: d("7") },
      { ...input(), evidenceMountPath: "/run/spawnfile-secrets/nested" },
      { ...input(), evidenceMountPath: "/run" },
      { ...input(), evidenceMountPath: "/etc/evidence" },
      { ...input(), evidenceMountPath: "/run/world/../evidence" },
      { ...input(), evidenceMountPath: "/run/world,evidence" },
      { ...input(), dataNetwork: { ...input().dataNetwork, name: evidence.name } },
      { ...input(), evidenceVolume: { ...input().evidenceVolume, labels: network.labels } },
      { ...input(), dataNetwork: { ...input().dataNetwork, labels: {
        ...network.labels, spawnfile_resource_v1_operation: "x"
      } } },
      { ...input(), evidenceVolume: { ...input().evidenceVolume, handle: network.resultHandle } },
      { ...input(), secretBindings: { ...input().secretBindings, name: "spfs_bad" } },
      { ...input(), secretBindings: { ...input().secretBindings, labels: createExistingDockerSecretSpec({
        bindingsHandle: h("4"), runId: "run-world-002", selectedTargetHandle
      }).labels } },
      { ...input(), secretBindings: { ...input().secretBindings, labels: createExistingDockerSecretSpec({
        bindingsHandle: h("4"), runId, selectedTargetHandle: h("7")
      }).labels } },
      { ...input(), operationHandle: "opaque_short" },
      { ...input(), unexpected: true }
    ];
    for (const attempt of attempts) expect(() => createDockerWorldServiceSpec(attempt as ReturnType<typeof input>))
      .toThrow(DOCKER_WORLD_SERVICE_ERROR);

    let hits = 0;
    const hostile = { ...input(), dataNetwork: Object.defineProperty({}, "handle", {
      enumerable: true, get: () => { hits += 1; return network.resultHandle; }
    }) };
    expect(() => createDockerWorldServiceSpec(hostile)).toThrow(DOCKER_WORLD_SERVICE_ERROR);
    expect(hits).toBe(0);

    const spec = createDockerWorldServiceSpec(input());
    expect(parseExpectedDockerWorldService("not-json", spec)).toBeNull();
    expect(parseExpectedDockerWorldService("[]", spec)).toBeNull();
    expect(parseExpectedDockerWorldService('[{"Id":"a","Id":"b"}]', spec)).toBeNull();
    expect(parseExpectedDockerWorldService("x".repeat(32_769), spec)).toBeNull();
  });

  it("bounds executor output and preserves only safe provider classifications", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    await expect(executeDockerWorldService({ args: ["version"], executor, timeoutMs: 12 }))
      .resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(executor).toHaveBeenCalledWith("docker", ["version"], { signal: undefined, timeout: 12 });

    const missing = new DockerWorldServiceProviderError("not_found");
    await expect(executeDockerWorldService({
      args: [], executor: vi.fn().mockRejectedValue(missing), timeoutMs: 1
    })).rejects.toBe(missing);
    await expect(executeDockerWorldService({
      args: [], executor: vi.fn().mockRejectedValue(new Error("private")), timeoutMs: 1
    })).rejects.toThrow(DOCKER_WORLD_SERVICE_ERROR);
    await expect(executeDockerWorldService({
      args: [], executor: vi.fn().mockResolvedValue({ stdout: "x".repeat(32_769), stderr: "" }), timeoutMs: 1
    })).rejects.toThrow(DOCKER_WORLD_SERVICE_ERROR);
  });
});
