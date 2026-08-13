import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import {
  DOCKER_SECRET_ERROR,
  DOCKER_SECRET_WRITER_IMAGE,
  MAX_SECRET_VALUE_BYTES,
  DockerSecretProviderError,
  createDockerSecretArchive,
  createExistingDockerSecretSpec,
  createPreparedDockerSecretSpec,
  executeDockerSecretCommand,
  isExpectedDockerSecretVolume,
  parseExpectedDockerSecretWriter
} from "./dockerSecretsProvider.js";

const operationHandle = parseOpaqueTargetHandle(`opaque_${"a".repeat(64)}`);
const requestDigest = `sha256:${"b".repeat(64)}`;
const targetHandle = parseOpaqueTargetHandle(`opaque_${"c".repeat(64)}`);
const spec = createPreparedDockerSecretSpec({ operationHandle, requestDigest, runId: "run-one", selectedTargetHandle: targetHandle });

const writerInspection = (changes: Record<string, unknown> = {}): string => JSON.stringify([{
  AutoRemove: true,
  BindCount: 0,
  CapAddCount: 0,
  CapDrop: ["ALL"],
  CgroupnsMode: "private",
  Cmd: spec.writerRunArgs.slice(-2),
  DeviceCount: 0,
  DeviceRequestCount: 0,
  DnsCount: 0,
  Domainname: "",
  Entrypoint: ["/bin/sh"],
  Env: spec.writerEnv,
  ExitCode: 0,
  ExposedPortCount: 0,
  ExtraHostCount: 0,
  GroupAddCount: 0,
  Hostname: spec.writerName,
  Image: DOCKER_SECRET_WRITER_IMAGE,
  IpcMode: "none",
  Labels: spec.writerLabels,
  LinkCount: 0,
  LogType: "none",
  Memory: 33_554_432,
  MountCount: 1,
  MountDestination: "/run/spawnfile-secrets",
  MountName: spec.volumeName,
  MountRW: true,
  MountType: "volume",
  Name: `/${spec.writerName}`,
  NanoCpus: 250_000_000,
  NetworkAttachmentCount: 1,
  NetworkAttachmentName: "none",
  NetworkMode: "none",
  OpenStdin: true,
  PidMode: "",
  PidsLimit: 32,
  PortBindingCount: 0,
  Privileged: false,
  PublishAllPorts: false,
  ReadonlyRootfs: true,
  RestartMaximumRetryCount: 0,
  RestartPolicyName: "no",
  SecurityOpt: ["no-new-privileges=true"],
  Status: "running",
  User: "0:0",
  UsernsMode: "",
  UTSMode: "",
  VolumesFromCount: 0,
  ...changes
}]);

describe("Docker secret provider specifications", () => {
  it("derives one fixed digest-pinned writer and the same exact volume from the opaque binding handle", () => {
    expect(DOCKER_SECRET_WRITER_IMAGE).toMatch(/^docker\.io\/library\/busybox@sha256:[a-f0-9]{64}$/u);
    expect(spec.writerRunArgs).toContain(DOCKER_SECRET_WRITER_IMAGE);
    expect(spec.writerRunArgs).toEqual(expect.arrayContaining([
      "--hostname", spec.writerName, "--network", "none", "--ipc", "none", "--cgroupns", "private",
      "--restart", "no", "--privileged=false", "--publish-all=false", "--log-driver", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
      "--user", "0:0", "--pull", "missing", "--quiet"
    ]));
    expect(spec.writerRunArgs.filter((value) => value === "--env")).toHaveLength(spec.writerEnv.length);
    expect(spec.writerEnv).toEqual(["PATH=/bin:/usr/bin", `HOSTNAME=${spec.writerName}`, "HOME=/root"]);
    const recovered = createExistingDockerSecretSpec({ bindingsHandle: spec.resultHandle, runId: "run-one", selectedTargetHandle: targetHandle });
    expect(recovered).toEqual(spec);
    expect(spec.volumeName).toMatch(/^spfs_[a-f0-9]{58}$/u);
    expect(spec.writerName).toMatch(/^spfw_[a-f0-9]{58}$/u);
  });

  it("accepts only exact projected volume and writer identities", () => {
    const volume = JSON.stringify([{ Driver: "local", Labels: spec.labels, Name: spec.volumeName, Options: null, Scope: "local" }]);
    expect(isExpectedDockerSecretVolume(volume, spec)).toBe(true);
    for (const hostile of [
      JSON.stringify([]), JSON.stringify([{ Driver: "local", Labels: spec.labels, Name: "other", Options: null, Scope: "local" }]),
      JSON.stringify([{ Driver: "nfs", Labels: spec.labels, Name: spec.volumeName, Options: null, Scope: "local" }]),
      JSON.stringify([{ Driver: "local", Id: "raw-id", Labels: spec.labels, Name: spec.volumeName, Options: null, Scope: "local" }]),
      JSON.stringify([{ Driver: "local", Labels: { ...spec.labels, extra: "value" }, Name: spec.volumeName, Options: null, Scope: "local" }]),
      `[{"Driver":"local","Name":"${spec.volumeName}","Labels":{},"Labels":${JSON.stringify(spec.labels)},"Options":null,"Scope":"local"}]`, "x".repeat(32_769)
    ]) expect(isExpectedDockerSecretVolume(hostile, spec)).toBe(false);

    expect(parseExpectedDockerSecretWriter(writerInspection(), spec)).toEqual({ exitCode: 0, status: "running" });
    for (const status of ["created", "dead", "exited", "paused", "removing", "restarting"] as const) {
      expect(parseExpectedDockerSecretWriter(writerInspection({ ExitCode: 1, Status: status }), spec)).toEqual({ exitCode: 1, status });
    }
    for (const hostile of [
      writerInspection({ Image: "busybox:latest" }), writerInspection({ AutoRemove: false }), writerInspection({ NetworkMode: "bridge" }),
      writerInspection({ NetworkAttachmentCount: 0 }), writerInspection({ NetworkAttachmentName: "bridge" }),
      writerInspection({ NetworkAttachmentCount: 2 }), writerInspection().replace(
        '"NetworkAttachmentName":"none"',
        '"NetworkAttachmentName":"none","NetworkAttachmentName":"bridge"'
      ),
      writerInspection({ LogType: "json-file" }), writerInspection({ MountCount: 2 }), writerInspection({ MountName: "other" }),
      writerInspection({ Cmd: ["sh", "-c", "cat"] }), writerInspection({ Labels: { ...spec.writerLabels, extra: "value" } }),
      writerInspection({ RestartPolicyName: "always" }), writerInspection({ RestartMaximumRetryCount: 1 }),
      writerInspection({ Privileged: true }), writerInspection({ CapAddCount: 1 }), writerInspection({ DeviceCount: 1 }),
      writerInspection({ DeviceRequestCount: 1 }), writerInspection({ PidMode: "host" }), writerInspection({ IpcMode: "host" }),
      writerInspection({ UTSMode: "host" }), writerInspection({ UsernsMode: "host" }), writerInspection({ CgroupnsMode: "host" }),
      writerInspection({ PortBindingCount: 1 }), writerInspection({ ExposedPortCount: 1 }), writerInspection({ PublishAllPorts: true }),
      writerInspection({ BindCount: 1 }), writerInspection({ VolumesFromCount: 1 }), writerInspection({ ExtraHostCount: 1 }),
      writerInspection({ DnsCount: 1 }), writerInspection({ GroupAddCount: 1 }), writerInspection({ LinkCount: 1 }),
      writerInspection({ Env: [...spec.writerEnv, "TOKEN=secret"] }), writerInspection({ Hostname: "forged" }),
      writerInspection({ ExitCode: 256 }), writerInspection({ Status: "unknown" }), writerInspection({ Id: "raw-container-id" }), JSON.stringify([]), "not-json"
    ]) expect(parseExpectedDockerSecretWriter(hostile, spec)).toBeNull();
  });

  it("bounds provider output, requires silent writer output, and never reflects thrown details", async () => {
    const secret = "sentinel-secret-provider-error";
    const invoke = (executor: Parameters<typeof executeDockerSecretCommand>[0]["executor"], requireSilent = false) => executeDockerSecretCommand({ args: [], executor, requireSilent, timeoutMs: 1 });
    await expect(invoke(async () => { throw new Error(secret); })).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(invoke(async () => ({ stderr: "", stdout: secret }), true)).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(invoke(async () => ({ stderr: "x".repeat(32_769), stdout: "" }))).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(invoke(async () => ({ stderr: "", stdout: "\ud800" }))).rejects.toThrow(DOCKER_SECRET_ERROR);
    await expect(invoke(async () => { throw new DockerSecretProviderError("not_found"); })).rejects.toMatchObject({ kind: "not_found", message: DOCKER_SECRET_ERROR });
  });
});

interface TarEntry { readonly data: Buffer; readonly mode: number; readonly path: string; readonly type: string; }
const trimNull = (value: Buffer): string => value.toString("ascii").replace(/\0.*$/u, "");
const readTar = (archive: Buffer): TarEntry[] => {
  const entries: TarEntry[] = []; let offset = 0;
  while (offset + 512 <= archive.length && archive.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const header = archive.subarray(offset, offset + 512); const name = trimNull(header.subarray(0, 100)); const prefix = trimNull(header.subarray(345, 500));
    const size = Number.parseInt(trimNull(header.subarray(124, 136)) || "0", 8); const mode = Number.parseInt(trimNull(header.subarray(100, 108)) || "0", 8);
    const path = prefix ? `${prefix}/${name}` : name; offset += 512;
    entries.push({ data: Buffer.from(archive.subarray(offset, offset + size)), mode, path, type: String.fromCharCode(header[156]!) });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
};

describe("Docker secret stdin archive", () => {
  it("is deterministic, bounded, path-safe, and preserves only scoped values plus a terminal marker", () => {
    const token = Buffer.from("sentinel-token-value"); const key = Buffer.from([0, 1, 2, 3, 255]);
    const archive = createDockerSecretArchive([
      { name: "token", scope: "world", value: token },
      { name: "api_key", scope: "agent", value: key }
    ]);
    expect(createDockerSecretArchive([{ name: "api_key", scope: "agent", value: key }, { name: "token", scope: "world", value: token }])).toEqual(archive);
    const entries = readTar(archive);
    expect(entries.map(({ mode, path, type }) => ({ mode, path, type }))).toEqual([
      { mode: 0o700, path: "agent/", type: "5" }, { mode: 0o700, path: "world/", type: "5" },
      { mode: 0o400, path: "agent/api_key", type: "0" }, { mode: 0o400, path: "world/token", type: "0" },
      { mode: 0o400, path: ".spawnfile-complete", type: "0" }
    ]);
    expect(entries.find(({ path }) => path === "agent/api_key")!.data).toEqual(key);
    expect(entries.find(({ path }) => path === "world/token")!.data.toString()).toBe("sentinel-token-value");
    expect(archive.subarray(-1_024)).toEqual(Buffer.alloc(1_024));
  });

  it("rejects duplicate destinations, unsafe identifiers, empty and oversized values", () => {
    const one = Buffer.from("one");
    expect(() => createDockerSecretArchive([{ name: "token", scope: "world", value: one }, { name: "token", scope: "world", value: one }])).toThrow(DOCKER_SECRET_ERROR);
    expect(() => createDockerSecretArchive([{ name: "../token", scope: "world", value: one }])).toThrow(DOCKER_SECRET_ERROR);
    expect(() => createDockerSecretArchive([{ name: "token", scope: "world", value: Buffer.alloc(0) }])).toThrow(DOCKER_SECRET_ERROR);
    expect(() => createDockerSecretArchive([{ name: "token", scope: "world", value: Buffer.alloc(MAX_SECRET_VALUE_BYTES + 1) }])).toThrow(DOCKER_SECRET_ERROR);
    expect(() => createDockerSecretArchive(Array.from({ length: 4 }, (_, index) => ({ name: `token_${index}`, scope: "world", value: Buffer.alloc(MAX_SECRET_VALUE_BYTES) })))).toThrow(DOCKER_SECRET_ERROR);
  });
});
