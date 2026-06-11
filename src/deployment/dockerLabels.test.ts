import { describe, expect, it } from "vitest";

import {
  appendDockerLabelArgs,
  createDockerDeploymentLabels,
  dockerDeploymentLabelKeys
} from "./dockerLabels.js";

describe("docker deployment labels", () => {
  it("creates identifier-only label values", () => {
    expect(createDockerDeploymentLabels({
      compileFingerprint: "sf1:abc123",
      deployment: "prod-eu",
      project: "agentic-org",
      unit: "prod-eu-container",
      version: "0.1"
    })).toEqual({
      [dockerDeploymentLabelKeys.compileFingerprint]: "sf1:abc123",
      [dockerDeploymentLabelKeys.deployment]: "prod-eu",
      [dockerDeploymentLabelKeys.project]: "agentic-org",
      [dockerDeploymentLabelKeys.unit]: "prod-eu-container",
      [dockerDeploymentLabelKeys.version]: "0.1"
    });
  });

  it("rejects local paths and other non-identifiers", () => {
    expect(() => createDockerDeploymentLabels({
      compileFingerprint: "sf1:abc123",
      deployment: "prod",
      project: "/Users/apresmoi/project",
      unit: "prod-container",
      version: "0.1"
    })).toThrow(/must be an identifier/);
  });

  it("appends stable --label arguments", () => {
    const args = ["run"];
    appendDockerLabelArgs(args, {
      "com.spawnfile.version": "0.1",
      "com.spawnfile.project": "agentic-org"
    });

    expect(args).toEqual([
      "run",
      "--label",
      "com.spawnfile.project=agentic-org",
      "--label",
      "com.spawnfile.version=0.1"
    ]);
  });
});
