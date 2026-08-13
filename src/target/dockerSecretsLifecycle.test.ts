import { describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import { cleanupExactDockerSecretBindings } from "./dockerSecretsLifecycle.js";
import {
  DOCKER_SECRET_WRITER_IMAGE,
  DockerSecretProviderError,
  createExistingDockerSecretSpec,
  type DockerSecretExecutor,
  type DockerSecretSpec
} from "./dockerSecretsProvider.js";

const authority = {
  bindingsHandle: parseOpaqueTargetHandle(`opaque_${"b".repeat(64)}`),
  runId: "run-one",
  selectedTargetHandle: parseOpaqueTargetHandle(`opaque_${"t".repeat(64)}`)
};
const secret = createExistingDockerSecretSpec(authority);

const volumeProjection = (spec: DockerSecretSpec): string => JSON.stringify([{
  Driver: "local", Labels: spec.labels, Name: spec.volumeName, Options: null, Scope: "local"
}]);

const writerProjection = (spec: DockerSecretSpec, status: string): string => {
  const imageIndex = spec.writerRunArgs.indexOf(DOCKER_SECRET_WRITER_IMAGE);
  return JSON.stringify([{
    AutoRemove: true, BindCount: 0, CapAddCount: 0, CapDrop: ["ALL"], CgroupnsMode: "private",
    Cmd: spec.writerRunArgs.slice(imageIndex + 1), DeviceCount: 0, DeviceRequestCount: 0,
    DnsCount: 0, Domainname: "", Entrypoint: ["/bin/sh"], Env: spec.writerEnv, ExitCode: 0,
    ExposedPortCount: 0, ExtraHostCount: 0, GroupAddCount: 0, Hostname: spec.writerName,
    Image: DOCKER_SECRET_WRITER_IMAGE, IpcMode: "none", Labels: spec.writerLabels, LinkCount: 0,
    LogType: "none", Memory: 33_554_432, MountCount: 1,
    MountDestination: "/run/spawnfile-secrets", MountName: spec.volumeName, MountRW: true,
    MountType: "volume", Name: `/${spec.writerName}`, NanoCpus: 250_000_000,
    NetworkAttachmentCount: 1, NetworkAttachmentName: "none", NetworkMode: "none",
    OpenStdin: true, PidMode: "", PidsLimit: 32, PortBindingCount: 0, Privileged: false,
    PublishAllPorts: false, ReadonlyRootfs: true, RestartMaximumRetryCount: 0,
    RestartPolicyName: "no", SecurityOpt: ["no-new-privileges=true"], Status: status,
    User: "0:0", UsernsMode: "", UTSMode: "", VolumesFromCount: 0
  }]);
};

const fixture = (input?: {
  readonly ambiguous?: "stop" | "writer_rm" | "volume_rm";
  readonly ambiguousRemains?: "stop" | "writer_rm" | "volume_rm";
  readonly badAck?: "stop" | "writer_rm" | "volume_rm";
  readonly foreignAfter?: "writer_rm" | "volume_rm";
  readonly replaceVolumeDuringWriterCleanup?: boolean;
  readonly starts?: "absent" | "exited" | "running";
  readonly stopRemoves?: boolean;
}) => {
  const calls: string[][] = [];
  const executions: Array<{ signal?: AbortSignal; timeout: number }> = [];
  let writer: "absent" | "exited" | "running" = input?.starts ?? "running";
  let volume = input?.starts === "absent" ? "absent" : "present";
  let volumeReplaced = false;
  const executor: DockerSecretExecutor = async (_file, args, execution) => {
    calls.push([...args]);
    executions.push(execution);
    const subject = args[2]; const operation = args[3];
    if (subject === "container" && operation === "inspect") {
      if (writer === "absent") throw new DockerSecretProviderError("not_found");
      if (input?.foreignAfter === "writer_rm" && calls.some((call) => call[3] === "rm" && call[2] === "container")) {
        return { stderr: "", stdout: writerProjection({ ...secret, writerLabels: { ...secret.writerLabels, forged: "yes" } }, writer) };
      }
      return { stderr: "", stdout: writerProjection(secret, writer) };
    }
    if (subject === "container" && operation === "stop") {
      if (input?.ambiguousRemains !== "stop") {
        writer = input?.stopRemoves ? "absent" : "exited";
      }
      if (input?.ambiguousRemains === "stop") throw new Error("transport");
      if (input?.ambiguous === "stop") throw new Error("transport");
      return { stderr: "", stdout: input?.badAck === "stop" ? secret.writerName : `${secret.writerName}\n` };
    }
    if (subject === "container" && operation === "rm") {
      if (input?.ambiguousRemains !== "writer_rm") {
        writer = input?.foreignAfter === "writer_rm" ? "exited" : "absent";
      }
      if (input?.replaceVolumeDuringWriterCleanup) volumeReplaced = true;
      if (input?.ambiguousRemains === "writer_rm") throw new Error("transport");
      if (input?.ambiguous === "writer_rm") throw new Error("transport");
      return { stderr: "", stdout: input?.badAck === "writer_rm" ? secret.writerName : `${secret.writerName}\n` };
    }
    if (subject === "volume" && operation === "inspect") {
      if (volume === "absent") throw new DockerSecretProviderError("not_found");
      if (volumeReplaced) {
        return {
          stderr: "",
          stdout: volumeProjection({
            ...secret,
            labels: { ...secret.labels, spawnfile_resource_v1_kind: "replacement" }
          })
        };
      }
      if (input?.foreignAfter === "volume_rm" && calls.some((call) => call[3] === "rm" && call[2] === "volume")) {
        return { stderr: "", stdout: volumeProjection({ ...secret, labels: { ...secret.labels, forged: "yes" } }) };
      }
      return { stderr: "", stdout: volumeProjection(secret) };
    }
    if (subject === "volume" && operation === "rm") {
      if (input?.ambiguousRemains !== "volume_rm") {
        volume = input?.foreignAfter === "volume_rm" ? "present" : "absent";
      }
      if (input?.ambiguousRemains === "volume_rm") throw new Error("transport");
      if (input?.ambiguous === "volume_rm") throw new Error("transport");
      return { stderr: "", stdout: input?.badAck === "volume_rm" ? secret.volumeName : `${secret.volumeName}\n` };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { calls, executions, executor };
};

const options = (executor: DockerSecretExecutor) => ({
  context: "production", executor, timeoutMs: 10_000
});

describe("exact Docker secret lifecycle cleanup", () => {
  it("stops an active writer, normally removes it, proves absence, then removes and proves the volume", async () => {
    const value = fixture();
    await expect(cleanupExactDockerSecretBindings(authority, options(value.executor))).resolves.toBeUndefined();
    expect(value.calls.map((call) => [call[2], call[3]])).toEqual([
      ["container", "inspect"], ["volume", "inspect"],
      ["container", "stop"], ["container", "inspect"],
      ["container", "inspect"], ["container", "rm"], ["container", "inspect"],
      ["volume", "inspect"], ["volume", "rm"], ["volume", "inspect"]
    ]);
    expect(value.calls.find((call) => call[3] === "stop")).toEqual([
      "--context", "production", "container", "stop", "--timeout", "10", secret.writerName
    ]);
    expect(value.calls.flat()).not.toEqual(expect.arrayContaining(["list", "ls", "ps", "prune", "--force"]));
    expect(value.calls.filter((call) => call[3] === "stop")).toHaveLength(1);
    expect(value.calls.filter((call) => call[3] === "rm" && call[2] === "container")).toHaveLength(1);
    expect(value.calls.filter((call) => call[3] === "rm" && call[2] === "volume")).toHaveLength(1);
  });

  it("is idempotent when absent and skips stop for an inactive exact writer", async () => {
    const absent = fixture({ starts: "absent" });
    await cleanupExactDockerSecretBindings(authority, options(absent.executor));
    expect(absent.calls.map((call) => [call[2], call[3]])).toEqual([
      ["container", "inspect"], ["volume", "inspect"]
    ]);
    const exited = fixture({ starts: "exited" });
    await cleanupExactDockerSecretBindings(authority, options(exited.executor));
    expect(exited.calls.some((call) => call[3] === "stop")).toBe(false);

    const autoRemoved = fixture({ stopRemoves: true });
    await cleanupExactDockerSecretBindings(authority, options(autoRemoved.executor));
    expect(autoRemoved.calls.some((call) => call[2] === "container" && call[3] === "rm")).toBe(false);
  });

  it.each(["stop", "writer_rm", "volume_rm"] as const)(
    "reconciles ambiguous %s without a second mutation",
    async (ambiguous) => {
      const value = fixture({ ambiguous });
      await expect(cleanupExactDockerSecretBindings(authority, options(value.executor))).resolves.toBeUndefined();
      expect(value.calls.filter((call) => call[3] === (ambiguous === "stop" ? "stop" : "rm")
        && (ambiguous === "volume_rm" ? call[2] === "volume" : call[2] === "container"))).toHaveLength(1);
    }
  );

  it.each(["stop", "writer_rm", "volume_rm"] as const)(
    "fails when ambiguous %s leaves the exact resource present, without retrying mutation",
    async (ambiguousRemains) => {
      const value = fixture({ ambiguousRemains });
      await expect(cleanupExactDockerSecretBindings(authority, options(value.executor)))
        .rejects.toThrow("Docker secret materialization failed");
      expect(value.calls.filter((call) => call[3] === (ambiguousRemains === "stop" ? "stop" : "rm")
        && (ambiguousRemains === "volume_rm"
          ? call[2] === "volume"
          : call[2] === "container"))).toHaveLength(1);
    }
  );

  it("forwards the exact signal and timeout to every provider call", async () => {
    const value = fixture();
    const controller = new AbortController();
    await cleanupExactDockerSecretBindings(authority, {
      context: "production",
      executor: value.executor,
      signal: controller.signal,
      timeoutMs: 7_777
    });
    for (const execution of value.executions) {
      expect(execution).toEqual({ signal: controller.signal, timeout: 7_777 });
    }
  });

  it("does not touch a volume replaced during writer cleanup", async () => {
    const value = fixture({ replaceVolumeDuringWriterCleanup: true });
    await expect(cleanupExactDockerSecretBindings(authority, options(value.executor)))
      .rejects.toThrow("Docker secret materialization failed");
    expect(value.calls.filter((call) =>
      call[2] === "volume" && call[3] === "rm")).toHaveLength(0);
  });

  it.each(["stop", "writer_rm", "volume_rm"] as const)("rejects noncanonical %s acknowledgement", async (badAck) => {
    const value = fixture({ badAck });
    await expect(cleanupExactDockerSecretBindings(authority, options(value.executor)))
      .rejects.toThrow("Docker secret materialization failed");
  });

  it.each(["writer_rm", "volume_rm"] as const)("fails closed when %s leaves a foreign replacement", async (foreignAfter) => {
    const value = fixture({ foreignAfter });
    await expect(cleanupExactDockerSecretBindings(authority, options(value.executor)))
      .rejects.toThrow("Docker secret materialization failed");
  });

  it("parses exact authority and options before any provider call", async () => {
    const value = fixture();
    for (const bad of [
      { ...authority, extra: true },
      { ...authority, bindingsHandle: "--force" },
      { ...authority, runId: "" }
    ]) {
      await expect(cleanupExactDockerSecretBindings(bad, options(value.executor)))
        .rejects.toThrow("Docker secret materialization failed");
    }
    await expect(cleanupExactDockerSecretBindings(authority, { ...options(value.executor), context: "--bad" }))
      .rejects.toThrow("Docker secret materialization failed");
    expect(value.calls).toHaveLength(0);
  });
});
