import { describe, expect, it } from "vitest";

import {
  EVIDENCE_EXPORT_MOUNT,
  EVIDENCE_EXPORT_HELPER_CMD,
  EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL,
  EVIDENCE_EXPORT_HELPER_ENTRYPOINT,
  EVIDENCE_EXPORT_HELPER_ENV,
  EVIDENCE_EXPORT_HELPER_USER,
  createEvidenceExportHelper,
  createEvidenceExportHelperSpec,
  executeEvidenceExport,
  isExpectedEvidenceExportHelper,
  isExpectedEvidenceExportImage,
  type DockerEvidenceExportExecutor,
  parseEvidenceVolumeAuthority
} from "./evidenceExportProvider.js";
import { parseOpaqueTargetHandle } from "./contracts.js";

const helper = () => createEvidenceExportHelper({
  artifactManifestDigest: `sha256:${"a".repeat(64)}`,
  imageDigest: `sha256:${"b".repeat(64)}`,
  imageReference: `docker.io/example/exporter@sha256:${"b".repeat(64)}`,
  resultHandle: "opaque_aaaaaaaaaaaaaaaa"
});
const authority = parseEvidenceVolumeAuthority({
  labels: {
    spawnfile_resource_v1_kind: "evidence_volume",
    spawnfile_resource_v1_operation: "o" + "a".repeat(63),
    spawnfile_resource_v1_run: "r" + "a".repeat(63),
    spawnfile_resource_v1_target: "t" + "a".repeat(63),
    spawnfile_resource_v1_version: "v1"
  },
  name: "spfv_" + "a".repeat(58),
  resultHandle: "opaque_cccccccccccccccc"
});

const helperImageProjection = (config: Record<string, unknown>): string => JSON.stringify([{
  RepoDigests: [`docker.io/example/exporter@sha256:${"b".repeat(64)}`],
  Config: config
}]);
const helperContainerProjection = (runtimeLabels: Record<string, string>, imageLabels: Record<string, string>, containerName: string): string => JSON.stringify([{
  Name: `/${containerName}`,
  Config: {
    Image: `docker.io/example/exporter@sha256:${"b".repeat(64)}`,
    Entrypoint: EVIDENCE_EXPORT_HELPER_ENTRYPOINT,
    Cmd: EVIDENCE_EXPORT_HELPER_CMD,
    Env: EVIDENCE_EXPORT_HELPER_ENV,
    ExposedPorts: null,
    Healthcheck: null,
    Labels: { ...imageLabels, ...runtimeLabels },
    User: EVIDENCE_EXPORT_HELPER_USER,
    Volumes: null
  },
  HostConfig: {
    AutoRemove: false, Binds: null, CapAdd: null, CapDrop: ["ALL"], CgroupnsMode: "private", DeviceRequests: null, Devices: [],
    Dns: null, ExtraHosts: null, GroupAdd: null, IpcMode: "none", Links: null,
    LogConfig: { Type: "none", Config: {} }, Memory: 134217728, NanoCpus: 250000000, NetworkMode: "none", PidMode: "", PidsLimit: 64, PortBindings: {},
    Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    SecurityOpt: ["no-new-privileges=true"], UTSMode: "", UsernsMode: "", VolumesFrom: null
  },
  Mounts: [{ Type: "volume", Name: authority.name, Destination: "/spawnfile/evidence", RW: false }]
}]);
const helperContainerProjectionWithMissingRuntimeLabel = (imageLabels: Record<string, string>, containerName: string): string => {
  const projection = JSON.parse(helperContainerProjection({}, imageLabels, containerName)) as Record<string, unknown>[];
  projection[0]!.Config = { ...(projection[0]!.Config as Record<string, unknown>) };
  (projection[0]!.Config as Record<string, unknown>).Labels = imageLabels;
  return JSON.stringify(projection);
};
describe("evidence export helper contract", () => {
  it("lowers one prepared immutable helper to a fixed isolated create contract", () => {
    const spec = createEvidenceExportHelperSpec({
      authority,
      helper: helper(),
      imageLabels: { [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL]: "v1" },
      operationHandle: parseOpaqueTargetHandle("opaque_dddddddddddddddd"),
      requestDigest: `sha256:${"d".repeat(64)}`
    });
    expect(spec.createArgs).toEqual(expect.arrayContaining([
      "container", "create", "--pull", "never", "--network", "none", "--restart", "no", "--log-driver", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--pids-limit", "64",
      "--memory", "128m", "--cpus", "0.25", "--ipc", "none", "--cgroupns", "private",
      "--mount", `type=volume,src=${authority.name},dst=/spawnfile/evidence,readonly,volume-nocopy`
    ]));
    expect(spec.createArgs).not.toContain("--pid");
    expect(spec.createArgs).not.toContain("--uts");
    expect(spec.createArgs).not.toContain("--entrypoint");
    expect(spec.createArgs).not.toContain("--publish");
    expect(spec.createArgs).not.toContain("--volumes-from");
    expect(spec.createArgs).not.toContain("--device");
  });

  it("accepts only an exact helper image projection", () => {
    const base = helper();
    const labels = { [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL]: "v1" };
    const validConfig = {
      Entrypoint: EVIDENCE_EXPORT_HELPER_ENTRYPOINT,
      Cmd: EVIDENCE_EXPORT_HELPER_CMD,
      Labels: labels,
      User: EVIDENCE_EXPORT_HELPER_USER,
      Env: EVIDENCE_EXPORT_HELPER_ENV,
      ExposedPorts: null,
      Healthcheck: null,
      Volumes: null
    };
    expect(isExpectedEvidenceExportImage(helperImageProjection(validConfig), base)).toBe(true);
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, Entrypoint: ["/bin/other"] }), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, Cmd: ["bad"] }), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, Labels: {} }), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, Labels: { ...labels, extra: "bad" } }), base)).toBe(false);
    for (const Env of [null, [], [EVIDENCE_EXPORT_HELPER_ENV[0], EVIDENCE_EXPORT_HELPER_ENV[0]],
      [...EVIDENCE_EXPORT_HELPER_ENV, "HOME=/bad"], ["PATH=/bad"], ["TOKEN=private"]]) {
      expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, Env }), base)).toBe(false);
    }
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, ExposedPorts: { "80/tcp": {} } }), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, Healthcheck: { Test: ["CMD-SHELL", "echo"] } }), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, Volumes: { "/tmp": {} } }), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, User: "0:0" }), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(JSON.stringify([{ RepoDigests: [`docker.io/example/exporter@sha256:${"c".repeat(64)}`], Config: validConfig }]), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(JSON.stringify([{ RepoDigests: [`docker.io/example/exporter@sha256:${"b".repeat(64)}`], Config: validConfig, Extra: true }]), base)).toBe(false);
    expect(isExpectedEvidenceExportImage(helperImageProjection({ ...validConfig, Extra: true } as Record<string, unknown>), base)).toBe(false);
  });

  it("accepts a locally attested config identity without RepoDigests", () => {
    const local = createEvidenceExportHelper({ artifactManifestDigest: `sha256:${"a".repeat(64)}`,
      imageDigest: `sha256:${"b".repeat(64)}`, imageReference: `sha256:${"b".repeat(64)}`,
      resultHandle: "opaque_aaaaaaaaaaaaaaaa" });
    const config = { Entrypoint: EVIDENCE_EXPORT_HELPER_ENTRYPOINT, Cmd: EVIDENCE_EXPORT_HELPER_CMD,
      Labels: { [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL]: "v1" }, User: EVIDENCE_EXPORT_HELPER_USER,
      Env: EVIDENCE_EXPORT_HELPER_ENV, ExposedPorts: null, Healthcheck: null, Volumes: null };
    expect(isExpectedEvidenceExportImage(JSON.stringify([{ RepoDigests: null, Config: config }]), local)).toBe(true);
  });

  it("accepts only an exact inspected helper container projection", () => {
    const spec = createEvidenceExportHelperSpec({
      authority,
      helper: helper(),
      imageLabels: { [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL]: "v1" },
      operationHandle: parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee"),
      requestDigest: `sha256:${"d".repeat(64)}`
    });
    const runtimeLabels = Object.fromEntries(spec.createArgs.filter((_, index) => spec.createArgs[index - 1] === "--label").map((value) => value.split("=", 2)));
    expect(isExpectedEvidenceExportHelper(helperContainerProjection(runtimeLabels, spec.imageLabels, spec.containerName), spec)).toBe(true);

    const base = JSON.parse(helperContainerProjection(runtimeLabels, spec.imageLabels, spec.containerName)) as unknown[];
    const projectionWithInvalidConfig = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const config = value[0]!.Config as Record<string, unknown>;
      config.Cmd = ["bad"];
      return JSON.stringify(value);
    };
    const projectionWithInvalidEnv = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const config = value[0]!.Config as Record<string, unknown>;
      config.Env = ["HOME=/bad"];
      return JSON.stringify(value);
    };
    const projectionWithInvalidExposedPorts = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const config = value[0]!.Config as Record<string, unknown>;
      config.ExposedPorts = { "80/tcp": {} };
      return JSON.stringify(value);
    };
    const projectionWithInvalidHealthcheck = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const config = value[0]!.Config as Record<string, unknown>;
      config.Healthcheck = { Test: ["CMD", "echo"] };
      return JSON.stringify(value);
    };
    const projectionWithInvalidVolumes = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const config = value[0]!.Config as Record<string, unknown>;
      config.Volumes = { "/tmp": {} };
      return JSON.stringify(value);
    };
    const projectionWithInvalidConfigMissingRuntimeLabel = () => helperContainerProjectionWithMissingRuntimeLabel(spec.imageLabels, spec.containerName);
    const projectionWithInvalidContractLabel = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const config = value[0]!.Config as Record<string, unknown>;
      const labels = { ...(config.Labels as Record<string, string>) };
      delete labels[EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL];
      config.Labels = labels;
      return JSON.stringify(value);
    };
    const projectionWithInvalidHostIpc = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const host = value[0]!.HostConfig as Record<string, unknown>;
      host.IpcMode = "host";
      return JSON.stringify(value);
    };
    const projectionWithInvalidDevice = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const host = value[0]!.HostConfig as Record<string, unknown>;
      host.Devices = [{ PathOnHost: "/dev/sda" }];
      return JSON.stringify(value);
    };
    const projectionWithInvalidPortBinding = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const host = value[0]!.HostConfig as Record<string, unknown>;
      host.PortBindings = { "80/tcp": [{ HostPort: "8080" }] };
      return JSON.stringify(value);
    };
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidConfigMissingRuntimeLabel(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidContractLabel(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidConfig(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidEnv(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidExposedPorts(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidHealthcheck(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidVolumes(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidHostIpc(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidDevice(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidPortBinding(), spec)).toBe(false);
    const projectionWithInvalidHostPid = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const host = value[0]!.HostConfig as Record<string, unknown>;
      host.PidMode = "host";
      return JSON.stringify(value);
    };
    const projectionWithInvalidHostUTS = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const host = value[0]!.HostConfig as Record<string, unknown>;
      host.UTSMode = "host";
      return JSON.stringify(value);
    };
    const projectionWithInvalidHost = () => {
      const value = structuredClone(base) as Record<string, unknown>[];
      const host = value[0]!.HostConfig as Record<string, unknown>;
      host.UsernsMode = "host";
      return JSON.stringify(value);
    };
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidHostPid(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidHostUTS(), spec)).toBe(false);
    expect(isExpectedEvidenceExportHelper(projectionWithInvalidHost(), spec)).toBe(false);
  });
});

describe("evidence export execution diagnostics", () => {
  const args = ["--context", "gpu-host", "container", "start", "--attach", "spfe_example"];

  it("distinguishes each bounded output-shape failure", async () => {
    const cases = [
      ["missing output", async () => undefined],
      ["output.bytes is not a Uint8Array", async () => ({ bytes: "not bytes" } as never)],
      ["exceeds MAX_OUTPUT_BYTES", async () => ({ bytes: new Uint8Array(67_108_865) })]
    ] as const;
    for (const [reason, executor] of cases) {
      await expect(executeEvidenceExport({ args, executor: executor as unknown as DockerEvidenceExportExecutor, timeoutMs: 1000 })).rejects.toThrow(reason);
    }
  });

  it("reports a thrown docker error with its bounded argv", async () => {
    await expect(executeEvidenceExport({
      args: ["--context", "gpu-host", "container", "start", "--attach", "spfe_example", "TOKEN=secret-value"],
      executor: async () => { throw new Error("Docker command failed"); },
      timeoutMs: 1000
    })).rejects.toThrow(/thrown failure: Error: Docker command failed; docker argv: .*TOKEN=\[REDACTED\]/u);
  });
});
