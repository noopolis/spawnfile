import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeDeploymentName,
  resolveDeploymentRecordPath,
  resolveDeploymentRecordsDirectory
} from "./names.js";

describe("deployment names", () => {
  it("defaults to default and accepts kebab-case names", () => {
    expect(normalizeDeploymentName(undefined)).toBe("default");
    expect(normalizeDeploymentName("prod-us-east")).toBe("prod-us-east");
  });

  it("rejects non-kebab-case names", () => {
    expect(() => normalizeDeploymentName("Prod")).toThrow(/kebab-case/);
    expect(() => normalizeDeploymentName("prod_us")).toThrow(/kebab-case/);
    expect(() => normalizeDeploymentName("prod--us")).toThrow(/kebab-case/);
  });

  it("resolves records under the compile output deployment directory", () => {
    expect(resolveDeploymentRecordsDirectory("/tmp/project/.spawn")).toBe(
      path.join("/tmp/project/.spawn", "deployments")
    );
    expect(resolveDeploymentRecordPath("/tmp/project/.spawn", "prod")).toBe(
      path.join("/tmp/project/.spawn", "deployments", "prod.json")
    );
  });
});
