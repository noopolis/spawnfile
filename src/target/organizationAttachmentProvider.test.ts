import { describe, expect, it, vi } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import {
  ORGANIZATION_ATTACHMENT_ERROR,
  ORGANIZATION_EGRESS_NETWORK_INSPECTION_FORMAT,
  ORGANIZATION_NETWORK_INSPECTION_FORMAT,
  DockerOrganizationAttachmentProviderError,
  createDockerOrganizationAttachmentSpec,
  executeDockerOrganizationAttachment,
  isExpectedOrganizationEgressNetwork,
  organizationTopologyInspectionFormat,
  parseExpectedOrganizationEgressNetwork,
  parseExpectedOrganizationContainer,
  parseExpectedOrganizationNetwork,
  parseOrganizationContainerId,
  parseOrganizationDeploymentLabels
} from "./organizationAttachmentProvider.js";

const labels = {
  "com.spawnfile.compile_fingerprint": "sf1:compile",
  "com.spawnfile.deployment": "football",
  "com.spawnfile.project": "test-project",
  "com.spawnfile.run_id": "run-attachment",
  "com.spawnfile.unit": "football-container",
  "com.spawnfile.version": "0.1"
};
const spec = createDockerOrganizationAttachmentSpec({
  containerId: "c".repeat(64),
  dataNetworkOperationHandle: parseOpaqueTargetHandle("opaque_1111111111111111"),
  dataNetworkRequestDigest: `sha256:${"1".repeat(64)}`,
  deploymentLabels: labels,
  operationHandle: parseOpaqueTargetHandle("opaque_2222222222222222"),
  organizationHandoffHandle: parseOpaqueTargetHandle("opaque_3333333333333333"),
  requestDigest: `sha256:${"2".repeat(64)}`,
  runId: "run-attachment",
  selectedTargetHandle: parseOpaqueTargetHandle("opaque_4444444444444444")
});

const networkProjection = (overrides: Record<string, unknown> = {}) => JSON.stringify([{
  Id: "a".repeat(64),
  Internal: true,
  Labels: spec.network.labels,
  Name: spec.network.name,
  ...overrides
}]);
const containerProjection = (attached: boolean, overrides: Record<string, unknown> = {}) =>
  JSON.stringify([{
    Attached: attached,
    Id: spec.containerId,
    Labels: labels,
    ...overrides
  }]);
const topologyProjection = (overrides: Record<string, unknown> = {}) => JSON.stringify([{
  DataAttached: true,
  DataNetworkId: "a".repeat(64),
  EgressNetworkId: "b".repeat(64),
  EgressNetworkName: "owner-egress",
  Id: spec.containerId,
  Labels: labels,
  NetworkAttachmentCount: 2,
  NetworkMode: "owner-egress",
  ...overrides
}]);

describe("organization attachment Docker provider", () => {
  it("derives only opaque public identity and exact private inspection projections", () => {
    expect(spec.resultHandle).toMatch(/^opaque_[a-f0-9]{64}$/u);
    expect(spec.network.resultHandle).toMatch(/^opaque_[a-f0-9]{64}$/u);
    expect(spec.containerInspectionFormat).toContain(spec.network.name);
    expect(spec.containerInspectionFormat).not.toContain(spec.containerId);
    expect(ORGANIZATION_NETWORK_INSPECTION_FORMAT).toContain("{{json .Id}}");
    const serialized = JSON.stringify(spec.receiptLabels);
    expect(serialized).not.toContain(spec.containerId);
    expect(serialized).not.toContain(spec.network.name);
    expect(serialized).not.toContain("football-container");
  });

  it("accepts only the exact internal network and six-label container projection", () => {
    expect(parseExpectedOrganizationNetwork(networkProjection(), spec)).toBe("a".repeat(64));
    expect(parseExpectedOrganizationContainer(containerProjection(true), spec)).toEqual({ attached: true });
    expect(parseExpectedOrganizationContainer(containerProjection(false), spec)).toEqual({ attached: false });
    for (const invalid of [
      networkProjection({ Id: "short" }),
      networkProjection({ Internal: false }),
      networkProjection({ Name: "other" }),
      networkProjection({ Labels: { ...spec.network.labels, extra: "v1" } }),
      networkProjection({ extra: true }),
      networkProjection().replace('"Id"', '"Id":"a","Id"')
    ]) expect(parseExpectedOrganizationNetwork(invalid, spec)).toBeNull();
    for (const invalid of [
      containerProjection(true, { Id: "d".repeat(64) }),
      containerProjection(true, { Labels: { ...labels, "com.spawnfile.run_id": "other" } }),
      containerProjection(true, { Labels: { ...labels, extra: "x" } }),
      containerProjection(true, { Attached: "true" }),
      containerProjection(true, { extra: true }),
      containerProjection(true).replace('"Id"', '"Id":"a","Id"')
    ]) expect(parseExpectedOrganizationContainer(invalid, spec)).toBeNull();
  });

  it("proves one exact non-internal organization egress network without returning it publicly", () => {
    expect(organizationTopologyInspectionFormat(spec.network.name)).toContain(spec.network.name);
    expect(ORGANIZATION_EGRESS_NETWORK_INSPECTION_FORMAT).not.toContain("owner-egress");
    const egress = parseExpectedOrganizationEgressNetwork(topologyProjection(), spec);
    expect(egress).toEqual({ dataNetworkId: "a".repeat(64), id: "b".repeat(64), name: "owner-egress" });
    expect(isExpectedOrganizationEgressNetwork(
      JSON.stringify([{ Id: egress!.id, Internal: false, Name: egress!.name }]), egress!
    )).toBe(true);
    for (const invalid of [
      topologyProjection({ NetworkAttachmentCount: 1 }),
      topologyProjection({ DataNetworkId: "invalid" }),
      topologyProjection({ EgressNetworkName: spec.network.name }),
      topologyProjection({ NetworkMode: "host" }),
      topologyProjection({ EgressNetworkName: "host/network" }),
      JSON.stringify([{ Id: "b".repeat(64), Internal: true, Name: "owner-egress" }]),
      JSON.stringify([{ Id: "b".repeat(64), Internal: false, Name: "other-egress" }]),
      JSON.stringify([{ Id: "c".repeat(64), Internal: false, Name: "owner-egress" }])
    ]) {
      if (invalid.includes("DataAttached")) {
        expect(parseExpectedOrganizationEgressNetwork(invalid, spec)).toBeNull();
      } else {
        expect(isExpectedOrganizationEgressNetwork(invalid, { id: "b".repeat(64), name: "owner-egress" })).toBe(false);
      }
    }
  });

  it("rejects raw-id and deployment-label drift at admission", () => {
    for (const invalid of ["", "abc", "A".repeat(64), "a".repeat(65)]) {
      expect(() => parseOrganizationContainerId(invalid)).toThrow(ORGANIZATION_ATTACHMENT_ERROR);
    }
    for (const invalid of [
      { ...labels, extra: "x" },
      { ...labels, "com.spawnfile.run_id": "run/path" },
      Object.fromEntries(Object.entries(labels).slice(1)),
      new Proxy(labels, {})
    ]) expect(() => parseOrganizationDeploymentLabels(invalid)).toThrow();
  });

  it("runs one bounded fixed Docker command and preserves safe not-found classification", async () => {
    const executor = vi.fn(async () => ({ stderr: "", stdout: "ok" }));
    await expect(executeDockerOrganizationAttachment({
      args: ["--context", "gpu-host", "network", "connect", "a".repeat(64), "c".repeat(64)],
      executor,
      timeoutMs: 10_000
    })).resolves.toEqual({ stderr: "", stdout: "ok" });
    expect(executor).toHaveBeenCalledTimes(1);
    const missing = vi.fn(async (): Promise<never> => {
      throw new DockerOrganizationAttachmentProviderError("not_found");
    });
    await expect(executeDockerOrganizationAttachment({
      args: [], executor: missing, timeoutMs: 1
    })).rejects.toBeInstanceOf(DockerOrganizationAttachmentProviderError);
    const hostile = "private-container-secret";
    await expect(executeDockerOrganizationAttachment({
      args: [], executor: async () => { throw new Error(hostile); }, timeoutMs: 1
    })).rejects.toThrow(ORGANIZATION_ATTACHMENT_ERROR);
    await expect(executeDockerOrganizationAttachment({
      args: [], executor: async () => ({ stderr: "", stdout: "x".repeat(32_769) }), timeoutMs: 1
    })).rejects.toThrow(ORGANIZATION_ATTACHMENT_ERROR);
  });
});
