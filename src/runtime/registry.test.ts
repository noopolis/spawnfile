import { describe, expect, it } from "vitest";

import { listInstallSelectionRuntimes } from "./install.js";
import {
  createRuntimeLifecycleDiagnostics,
  getRegisteredRuntime,
  getRuntimeAdapter,
  listRuntimeAdapters,
  loadRuntimeRegistry
} from "./registry.js";

describe("runtime registry", () => {
  it("lists available runtime adapters", () => {
    expect(listRuntimeAdapters()).toEqual(["openclaw", "picoclaw", "tinyclaw"]);
  });

  it("loads runtimes from runtimes.yaml", async () => {
    const openClaw = await getRegisteredRuntime("openclaw");

    expect(openClaw).toMatchObject({
      name: "openclaw",
      ref: "v2026.3.13-1",
      status: "active"
    });
  });

  it("keeps bundled adapters aligned with compileable runtime registry entries", async () => {
    const compileableRuntimeNames = (await loadRuntimeRegistry())
      .filter((entry) => entry.status === "active" || entry.status === "deprecated")
      .map((entry) => entry.name)
      .sort();

    expect(listRuntimeAdapters()).toEqual(compileableRuntimeNames);
    expect(listInstallSelectionRuntimes()).toEqual(compileableRuntimeNames);
  });

  it("returns a runtime adapter by name", () => {
    expect(getRuntimeAdapter("openclaw").name).toBe("openclaw");
  });

  it("throws on unknown runtime adapters", () => {
    expect(() => getRuntimeAdapter("unknown")).toThrowError(/Unknown runtime adapter/);
  });

  it("creates a warning diagnostic for deprecated runtimes", () => {
    expect(
      createRuntimeLifecycleDiagnostics({
        name: "legacyclaw",
        ref: "v1.2.3",
        status: "deprecated"
      })
    ).toEqual([
      {
        level: "warn",
        message: "Runtime legacyclaw is deprecated in Spawnfile and pinned at v1.2.3"
      }
    ]);
  });
});
