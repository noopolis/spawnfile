import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import manifestV5 from "./contract-manifest.json" with { type: "json" };
import mirror from "./engine-descriptors.json" with { type: "json" };
import { DAIMON_ENGINE_DESCRIPTOR_SOURCE_COMMIT, DAIMON_V5_ENGINE_DESCRIPTORS } from "./engineDescriptors.generated.js";
import { parseDaimonContractManifest } from "./contractManifest.js";
import { DAIMON_CONTRACT_MANIFEST_V6_JSON_SCHEMA, DAIMON_CONTRACT_MANIFEST_V6_VERSION } from "./contractManifestSchema.js";
import { parseDaimonEngineDescriptors } from "./engineDescriptorSchema.js";
import { createPiTestNode } from "../pi/testHelpers.js";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const v6 = () => ({ ...structuredClone(manifestV5), version: DAIMON_CONTRACT_MANIFEST_V6_VERSION,
  engines: structuredClone(DAIMON_V5_ENGINE_DESCRIPTORS) as Mutable<typeof DAIMON_V5_ENGINE_DESCRIPTORS> });
afterEach(() => { vi.doUnmock("./contract-manifest.json"); vi.resetModules(); });

describe("Daimon descriptor authority", () => {
  it("binds the v5 fallback, typed mirror and digest to the registry's exact source pin", async () => {
    const registry = parseYaml(await readFile(new URL("../../../runtimes.yaml", import.meta.url), "utf8")) as { runtimes: { daimon: { ref: string } } };
    const bytes = await readFile(new URL("./engine-descriptors.json", import.meta.url));
    const digest = await readFile(new URL("./engine-descriptors.sha256", import.meta.url), "utf8");
    expect(digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}\n`);
    expect(mirror.sourceCommit).toBe(registry.runtimes.daimon.ref);
    expect(DAIMON_ENGINE_DESCRIPTOR_SOURCE_COMMIT).toBe(mirror.sourceCommit);
    expect(DAIMON_V5_ENGINE_DESCRIPTORS).toEqual(mirror.engines);
    expect(parseDaimonContractManifest(manifestV5).engines).toEqual(mirror.engines);
    expect(parseDaimonContractManifest(manifestV5).supportedEngineKinds).toEqual(["agy", "codex", "grok"]);
  });

  it("accepts v6 through both the portable JSON Schema and consumed-contract parser", () => {
    const ajv = new Ajv2020.default({ strict: false });
    const validate = ajv.compile(DAIMON_CONTRACT_MANIFEST_V6_JSON_SCHEMA);
    expect(validate(v6()), JSON.stringify(validate.errors)).toBe(true);
    expect(parseDaimonContractManifest(v6()).engines).toEqual(mirror.engines);
    const malformed = { ...v6(), engines: { ...v6().engines, codex: { ...v6().engines.codex, unknown: true } } };
    expect(validate(malformed)).toBe(false);
    expect(() => parseDaimonContractManifest(malformed)).toThrow(/v6 schema/u);
  });

  it("does not accept injected descriptors as v5 authority", () => {
    expect(() => parseDaimonContractManifest({ ...manifestV5, engines: mirror.engines })).toThrow(/v5/u);
    expect(() => parseDaimonContractManifest({ ...v6(), version: "noopolis.daimon.runtime-contract-manifest.v7" })).toThrow(/manifest/u);
  });

  it("requires inventory parity and every v5 section in v6", () => {
    expect(() => parseDaimonContractManifest({ ...v6(), supportedEngineKinds: ["codex", "grok", "agy"] })).toThrow(/configuration/u);
    for (const key of ["engines", "organizationRuntimeConfigSchema", "deliverySemantics"]) {
      const value: Record<string, unknown> = v6(); delete value[key];
      expect(() => parseDaimonContractManifest(value)).toThrow(/v6 schema/u);
    }
  });

  it("accepts an additional portable engine with descriptor-owned credential material", () => {
    const value = v6();
    const extra = { ...structuredClone(value.engines.codex), id: "another-cli", credentialMaterial: {
      ...value.engines.codex.credentialMaterial, destinationRelativePath: ".another/auth.json",
      sourceRelativePath: ".daimon-inbound/another-auth", sourceSlot: "another-auth"
    } };
    const parsed = parseDaimonContractManifest({ ...value,
      engines: { ...value.engines, [extra.id]: extra }, supportedEngineKinds: ["agy", "another-cli", "codex", "grok"],
      engineCredentialMaterial: { ...value.engineCredentialMaterial, [extra.id]: extra.credentialMaterial }
    });
    expect(parsed.engines[extra.id]).toEqual(extra);
    expect(parsed.engineCredentialMaterial[extra.id]).toEqual(extra.credentialMaterial);
  });

  it("preserves legacy import selection when another portable engine sorts first", async () => {
    const value = v6();
    const extra = { ...value.engines.codex, id: "another-cli" };
    const active = { ...value, engines: { [extra.id]: extra, ...value.engines },
      supportedEngineKinds: ["agy", "another-cli", "codex", "grok"],
      engineCredentialMaterial: { ...value.engineCredentialMaterial, [extra.id]: extra.credentialMaterial } };
    vi.resetModules(); vi.doMock("./contract-manifest.json", () => ({ default: active }));
    const engines = await import("./engines.js");
    expect(engines.DAIMON_ENGINES).toContain("another-cli");
    expect(engines.DAIMON_PORTABLE_ENGINE_ID).toBe("codex");
  });

  it.each([
    (value: ReturnType<typeof v6>) => { value.engines.codex.id = "other" as "codex"; },
    (value: ReturnType<typeof v6>) => { value.engines.codex.credentialMaterial.sourceRelativePath = "../escape" as ".daimon-inbound/codex-auth"; },
    (value: ReturnType<typeof v6>) => { value.engines.grok.capabilities.broker = false as true; },
    (value: ReturnType<typeof v6>) => { value.engines.grok.broker.nativeAbiVersion = 1 as 2; },
    (value: ReturnType<typeof v6>) => { value.engines.grok.modelSelection.reasoningEfforts = ["medium", "low", "high"] as unknown as typeof value.engines.grok.modelSelection.reasoningEfforts; },
    (value: ReturnType<typeof v6>) => { value.engines.agy.training.subject.supported = true as false; }
  ])("rejects malformed or inconsistent descriptor facts", mutate => {
    const value = v6(); mutate(value);
    expect(() => parseDaimonContractManifest(value)).toThrow(/manifest/u);
  });

  it("refuses missing or weakened sandbox facts for the supported broker ABI", () => {
    const value = v6();
    expect(() => parseDaimonContractManifest({ ...value, engines: { ...value.engines,
      grok: { ...value.engines.grok, sandbox: { configurable: false } } } })).toThrow(/descriptors/u);
    expect(() => parseDaimonContractManifest({ ...value, engines: { ...value.engines,
      grok: { ...value.engines.grok, sandbox: { ...value.engines.grok.sandbox, restrictNetwork: false } } } })).toThrow(/descriptors/u);
  });

  it("refuses ambiguous engine ownership of singleton legacy realms", () => {
    for (const id of ["grok", "agy"] as const) {
      const value = v6(); const extra = { ...value.engines[id], id: "another-engine" };
      expect(() => parseDaimonContractManifest({ ...value, engines: { ...value.engines, [extra.id]: extra },
        supportedEngineKinds: [...value.supportedEngineKinds, extra.id].sort() })).toThrow(/inconsistent engine/u);
    }
  });

  it("rejects non-objects and malformed source data before compilation", () => {
    for (const value of [undefined, null, [], {}, { x: {} }]) expect(() => parseDaimonEngineDescriptors(value)).toThrow(/descriptors/u);
  });

  it("takes v6 inventory, broker and training capability from descriptor content", async () => {
    const value = v6();
    const { grok, ...others } = value.engines;
    const renamed = { ...grok, id: "new-broker" };
    const active = { ...value, engines: { ...others, "new-broker": renamed }, supportedEngineKinds: ["agy", "codex", "new-broker"] };
    vi.resetModules(); vi.doMock("./contract-manifest.json", () => ({ default: active }));
    const engines = await import("./engines.js");
    const { daimonAdapter } = await import("./adapter.js");
    const { createDaimonContainerTargets } = await import("./config.js");
    expect(engines.DAIMON_ENGINES).toEqual(active.supportedEngineKinds);
    expect(engines.daimonTrainingDeclaration.engines).toEqual(active.supportedEngineKinds);
    expect(engines.daimonEngineHasBroker("new-broker")).toBe(true);
    expect(engines.daimonEngineHasBroker("grok")).toBe(false);
    expect(engines.getDaimonEngineDescriptor("agy")?.training.subject.supported).toBe(false);
    expect(daimonAdapter.validateRuntimeOptions!({ engine: "grok" })[0]!.message).toBe("Daimon runtime option engine must be one of agy, codex, new-broker");
    expect(daimonAdapter.validateRuntimeOptions!({ engine: "new-broker" })).toEqual([]);
    const node = createPiTestNode({ runtime: { name: "daimon", options: { engine: "new-broker", turn_limits: { max_requests: 12 } } },
      execution: { model: { primary: { auth: { method: "grok" }, name: "grok-4.6", provider: "xai", reasoning_effort: "low" } } } });
    const targets = await createDaimonContainerTargets([{ emittedFiles: [], id: "agent:test", kind: "agent", slug: "test", value: node }]);
    expect(targets[0]!.engineByNodeId).toEqual({ "agent:test": "new-broker" });
    expect(targets[0]!.grokTurnLimitsByNodeId).toEqual({ "agent:test": { maxRequests: 12 } });
    expect(targets[0]!.grokModelByNodeId).toEqual({ "agent:test": { model: "grok-4.6", reasoningEffort: "low" } });
  });
});
