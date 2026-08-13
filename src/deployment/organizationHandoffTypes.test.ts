import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createOrganizationDeploymentHandle,
  createOrganizationHandoff,
  parseCanonicalSha256Digest,
  parseOrganizationHandoff
} from "./organizationHandoffTypes.js";
import { parseOpaqueTargetHandle } from "../target/index.js";

const digest = (character: string) => parseCanonicalSha256Digest(`sha256:${character.repeat(64)}`);
const input = {
  bindingDigest: digest("b"),
  networkAttachmentHandle: parseOpaqueTargetHandle("opaque_0123456789abcdef"),
  selectedTargetReceiptDigest: digest("a")
};

const importedModules = (source: string): string[] =>
  [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]!);

const forbiddenH2Module = /(?:dockerInspect|dockerProbeGateway|provider|client|moltnet|simfile|world|simulation)/iu;

describe("organization handoff contract", () => {
  it("derives the fixed domain-separated deployment handle vector", () => {
    const handoff = createOrganizationHandoff("run-from-host", input);

    expect(handoff.deployment_handle).toBe(
      "sf-oh1-3d159b6ac05edc1295b4e1ebbc9ac424d779c899bb0b7d424d66de9ae42828d0"
    );
    expect(createOrganizationDeploymentHandle({
      binding_digest: handoff.binding_digest,
      lifecycle_receipts: handoff.lifecycle_receipts,
      network_attachment_handle: handoff.network_attachment_handle,
      run_id: handoff.run_id,
      selected_target_receipt_digest: handoff.selected_target_receipt_digest
    })).toBe(handoff.deployment_handle);
    expect(parseOrganizationHandoff(handoff)).toEqual(handoff);
  });

  it("rejects strict-schema, derived-handle, and receipt-version mutations", () => {
    const handoff = createOrganizationHandoff("run-2026-07-22", input);
    const mutations = [
      { ...handoff, extra: true },
      { ...handoff, deployment_handle: `sf-oh1-${"0".repeat(64)}` },
      { ...handoff, lifecycle_receipts: { ...handoff.lifecycle_receipts, up: "spawnfile.up-receipt.v2" } },
      { ...handoff, lifecycle_receipts: { ...handoff.lifecycle_receipts, extra: "x" } },
      { ...handoff, selected_target_receipt_digest: "sha256:ABC" },
      { ...handoff, binding_digest: `sha256:${"B".repeat(64)}` }
    ];

    for (const mutation of mutations) {
      expect(() => parseOrganizationHandoff(mutation)).toThrow(/invalid spawnfile.organization-handoff.v1/);
    }
  });

  it("rejects hostile JSON graphs without reflecting hostile keys or values", () => {
    const handoff = createOrganizationHandoff("run-2026-07-22", input);
    const hostileKey = "hostile_key_secret_123";
    const hostileValue = "hostile_value_token_456";
    const proxy = new Proxy({ ...handoff }, {});
    const accessor = Object.defineProperty({ ...handoff }, "run_id", {
      enumerable: true,
      get: () => "run-from-host"
    });
    const cyclic = { ...handoff } as typeof handoff & { self?: unknown };
    cyclic.self = cyclic;
    const overBudget = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`field_${index}`, "x"])
    );

    for (const invalid of [
      { ...handoff, [hostileKey]: hostileValue }, proxy, accessor, cyclic,
      new Date(), overBudget, { ...handoff, network_attachment_handle: "opaque_invalid" }
    ]) {
      let message = "";
      try {
        parseOrganizationHandoff(invalid);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("invalid spawnfile.organization-handoff.v1 artifact");
      expect(message).not.toContain(hostileKey);
      expect(message).not.toContain(hostileValue);
    }
    for (const runId of ["run/token", "x".repeat(129)]) {
      expect(() => createOrganizationHandoff(runId, input)).toThrow();
    }
    const serialized = JSON.stringify(handoff);
    for (const hostileValue of [
      "secret-token", "participant-1", "principal-1", "container-123",
      "https://endpoint", "/private/path", "topology", "raw error"
    ]) {
      expect(serialized).not.toContain(hostileValue);
    }
  });

  it("keeps handoff types and record parsing outside P0, probes, and provider imports", async () => {
    const sourceUrls = [
      new URL("./organizationHandoffTypes.ts", import.meta.url),
      new URL("./record.ts", import.meta.url)
    ];
    for (const sourceUrl of sourceUrls) {
      const source = await readFile(sourceUrl, "utf8");
      expect(importedModules(source).some((module) => forbiddenH2Module.test(module))).toBe(false);
    }
  });

  it("keeps the manager as the sole approved readiness and handoff authority", async () => {
    const source = await readFile(new URL("./dockerManager.ts", import.meta.url), "utf8");
    const modules = importedModules(source);
    expect(modules.filter((module) => /dockerInspect|dockerProbeGateway/u.test(module))).toEqual([
      "./dockerInspect.js",
      "./dockerProbeGateway.js"
    ]);
    expect(modules.some((module) => /provider/iu.test(module))).toBe(false);

    const deploymentRoot = new URL("./", import.meta.url);
    const compilerRoot = new URL("../compiler/", import.meta.url);
    const cliRoot = new URL("../cli/", import.meta.url);
    const productionSources = [
      ...(await readdir(deploymentRoot, { recursive: true })).map((file) => [deploymentRoot, file] as const),
      ...(await readdir(compilerRoot, { recursive: true })).map((file) => [compilerRoot, file] as const),
      ...(await readdir(cliRoot, { recursive: true })).map((file) => [cliRoot, file] as const)
    ].filter(([, file]) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    const handoffCallers: string[] = [];
    for (const [sourceRoot, file] of productionSources) {
      const source = await readFile(new URL(file, sourceRoot), "utf8");
      if (/\bcreateOrganizationHandoff\s*\(/u.test(source)) {
        handoffCallers.push(sourceRoot === deploymentRoot ? file : `${sourceRoot === compilerRoot ? "compiler" : "cli"}/${file}`);
      }
    }
    expect(handoffCallers).toEqual(["dockerManager.ts"]);
  });

  it("keeps H2 production paths free of bypass imports and construction", async () => {
    const paths = [
      new URL("../compiler/upProject.ts", import.meta.url),
      new URL("../compiler/upReceipt.ts", import.meta.url),
      new URL("./upReceiptTypes.ts", import.meta.url),
      new URL("../cli/lifecycleCommands.ts", import.meta.url)
    ];
    for (const sourceUrl of paths) {
      const source = await readFile(sourceUrl, "utf8");
      expect(importedModules(source).some((module) => forbiddenH2Module.test(module))).toBe(false);
      expect(source).not.toMatch(/\bcreateOrganizationHandoff\s*\(/u);
    }
  });

});
