import { describe, expect, it } from "vitest";

import { listInstallSelectionRuntimes } from "./install.js";
import {
  createRuntimeLifecycleDiagnostics,
  getRegisteredRuntime,
  getRuntimeAdapter,
  listRuntimeAdapters,
  loadRuntimeRegistry,
  parseRuntimeRegistry
} from "./registry.js";

describe("runtime registry", () => {
  it("lists available runtime adapters", () => {
    expect(listRuntimeAdapters()).toEqual(["daimon", "openclaw", "pi", "picoclaw"]);
  });

  it("loads runtimes from runtimes.yaml", async () => {
    const openClaw = await getRegisteredRuntime("openclaw");

    expect(openClaw).toMatchObject({
      install: {
        image: "noopolis/spawnfile-runtime-openclaw",
        kind: "container_image",
        tag: "2026.6.11"
      },
      name: "openclaw",
      ref: "v2026.6.11",
      status: "active"
    });
  });

  it("parses per-architecture Daimon capability receipts for a multi-architecture index", () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    const registry = (receipts: string) => [
      "runtimes:",
      "  daimon:",
      "    remote: https://example.invalid/daimon.git",
      "    ref: v1",
      "    default_branch: main",
      "    install:",
      "      kind: container_image",
      "      image: noopolis/spawnfile-runtime-daimon",
      "      tag: 1.0.0-abcdef0",
      `      digest: ${digest("a")}`,
      receipts,
      `      contract_manifest_sha256: ${digest("d")}`,
      "    status: active"
    ].join("\n");

    const [entry] = parseRuntimeRegistry(registry(`      capability_receipts:\n        amd64: ${digest("b")}\n        arm64: ${digest("c")}`));
    expect(entry?.install).toEqual({
      capabilityReceipts: { amd64: digest("b"), arm64: digest("c") },
      contractManifestSha256: digest("d"),
      digest: digest("a"),
      image: "noopolis/spawnfile-runtime-daimon",
      kind: "container_image",
      tag: "1.0.0-abcdef0"
    });
    expect(() => parseRuntimeRegistry(registry(`      capability_receipt: ${digest("b")}\n      capability_receipts:\n        amd64: ${digest("b")}`))).toThrow();
    expect(() => parseRuntimeRegistry(registry("      capability_receipts: {}"))).toThrow();
    expect(() => parseRuntimeRegistry(registry(`      capability_receipts:\n        s390x: ${digest("b")}`))).toThrow();
  });

  it("keeps bundled adapters aligned with compileable runtime registry entries", async () => {
    const compileableRuntimeNames = (await loadRuntimeRegistry())
      .filter((entry) => entry.status === "active" || entry.status === "deprecated")
      .map((entry) => entry.name)
      .sort();

    expect(listRuntimeAdapters()).toEqual(compileableRuntimeNames);
    await expect(listInstallSelectionRuntimes()).resolves.toEqual(compileableRuntimeNames);
  });

  it("returns a runtime adapter by name", () => {
    expect(getRuntimeAdapter("daimon").name).toBe("daimon");
    expect(getRuntimeAdapter("openclaw").name).toBe("openclaw");
    expect(getRuntimeAdapter("pi").name).toBe("pi");
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
