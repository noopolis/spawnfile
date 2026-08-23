import { describe, expect, it } from "vitest";

import { createDetachedContainerInspectArgs, parseDetachedContainerInspect } from "./runProjectDocker.js";

const id = "a".repeat(64);
const imageId = `sha256:${"b".repeat(64)}`;
const labels = {
  "com.spawnfile.compile_fingerprint": "sf1.abc", "com.spawnfile.deployment": "football",
  "com.spawnfile.project": "football", "com.spawnfile.run_id": "run-one",
  "com.spawnfile.unit": "football-container", "com.spawnfile.version": "0.1"
};
const inspected = (overrides: { id?: string; labels?: unknown; extra?: string } = {}): string =>
  `${JSON.stringify(overrides.id ?? id)}\n${JSON.stringify("/football")}\n${JSON.stringify(imageId)}\n${JSON.stringify(overrides.labels ?? labels)}${overrides.extra ?? ""}`;

describe("detached Docker inspection", () => {
  it("returns only the verified full id, image id, and exact deployment labels", () => {
    expect(parseDetachedContainerInspect(inspected(), id, labels, "football")).toEqual({ containerId: id, containerName: "football", imageId, deploymentLabels: labels });
  });

  it.each([
    ["wrong full id", inspected({ id: "b".repeat(64) })],
    ["missing label", inspected({ labels: { ...labels, "com.spawnfile.unit": undefined } })],
    ["changed label", inspected({ labels: { ...labels, "com.spawnfile.version": "0.2" } })],
    ["extra line", inspected({ extra: "\n{}" })],
    ["malformed response", "not-json"]
  ])("rejects %s before finalization", (_label, stdout) => {
    expect(() => parseDetachedContainerInspect(stdout, id, labels, "football")).toThrow();
  });

  it.each(["sha256:short", `sha256:${"A".repeat(64)}`, `sha256:${"c".repeat(65)}`])("rejects a non-canonical image id before finalization", (badImage) => {
    const stdout = `${JSON.stringify(id)}\n${JSON.stringify("/football")}\n${JSON.stringify(badImage)}\n${JSON.stringify(labels)}`;
    expect(() => parseDetachedContainerInspect(stdout, id, labels, "football")).toThrow();
  });

  it("uses the selected Docker context or host without name/list lookup", () => {
    const base = { args: [], command: "docker", containerName: "football", cwd: "/tmp", detach: true, envFilePath: "/tmp/run.env", imageTag: "football:latest", supportDirectory: "/tmp/support" };
    expect(createDetachedContainerInspectArgs({ ...base, dockerContext: "remote" }, id)).toEqual(["--context", "remote", "inspect", "--format", "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}", id]);
    expect(createDetachedContainerInspectArgs({ ...base, dockerHost: "ssh://host" }, id)).toEqual(["--host", "ssh://host", "inspect", "--format", "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}", id]);
  });
});
