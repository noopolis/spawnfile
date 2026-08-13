import { describe, expect, it } from "vitest";

import {
  createTargetTopologyAttestor,
  TARGET_TOPOLOGY_ATTESTATION_ERROR,
  type CreateTargetTopologyAttestorOptions,
} from "./topologyAttestation.js";

const executor = async () => ({ stderr: "", stdout: "" });
const attachmentStore = {
  loadAttachment: async () => { throw new Error("unused"); },
};
const worldStore = {
  loadService: async () => { throw new Error("unused"); },
};
const resolveJournal = async () => { throw new Error("unused"); };
const base = (): CreateTargetTopologyAttestorOptions => ({
  attachmentExecutor: executor,
  attachmentStore: attachmentStore as never,
  context: "target_1",
  resolveJournal,
  resourceExecutor: executor,
  timeoutMs: 10_000,
  worldExecutor: executor,
  worldStore: worldStore as never,
});
const changed = (
  update: (value: Record<PropertyKey, unknown>) => void,
): CreateTargetTopologyAttestorOptions => {
  const value = { ...base() } as Record<PropertyKey, unknown>;
  update(value);
  return value as unknown as CreateTargetTopologyAttestorOptions;
};
const reject = (value: unknown): void => {
  expect(() => createTargetTopologyAttestor(value as never))
    .toThrow(TARGET_TOPOLOGY_ATTESTATION_ERROR);
};

describe("topology attestor option validation", () => {
  it("accepts an exact plain dependency envelope and timeout boundaries", () => {
    expect(createTargetTopologyAttestor(base())).toBeDefined();
    expect(createTargetTopologyAttestor({ ...base(), timeoutMs: 1 })).toBeDefined();
    expect(createTargetTopologyAttestor({ ...base(), timeoutMs: 120_000 })).toBeDefined();
  });

  it("rejects non-plain and wrong-key envelopes before dependency use", () => {
    const inherited = Object.create({ inherited: true });
    Object.assign(inherited, base());
    const symbol = changed((value) => { value[Symbol("extra")] = true; });
    const missing = changed((value) => { delete value.worldStore; });
    const extra = changed((value) => { value.extra = true; });
    for (const value of [null, [], new Date(), inherited, symbol, missing, extra]) reject(value);
  });

  it("rejects accessors and non-enumerable dependency descriptors", () => {
    const accessor = { ...base() } as Record<string, unknown>;
    Object.defineProperty(accessor, "context", {
      enumerable: true,
      get: () => "target_1",
    });
    const hidden = { ...base() } as Record<string, unknown>;
    Object.defineProperty(hidden, "context", {
      enumerable: false,
      value: "target_1",
    });
    reject(accessor);
    reject(hidden);
  });

  it("requires every executor, resolver, and private store method", () => {
    for (const name of [
      "attachmentExecutor", "resolveJournal", "resourceExecutor", "worldExecutor",
    ]) reject(changed((value) => { value[name] = null; }));
    reject(changed((value) => { value.attachmentStore = null; }));
    reject(changed((value) => {
      value.attachmentStore = { ...attachmentStore, loadAttachment: null };
    }));
    reject(changed((value) => { value.worldStore = null; }));
    reject(changed((value) => {
      value.worldStore = { ...worldStore, loadService: null };
    }));
  });

  it("rejects invalid context and timeout scalars", () => {
    for (const context of [null, "", "UPPER", "a".repeat(65)]) {
      reject(changed((value) => { value.context = context; }));
    }
    for (const timeoutMs of [null, "1", 0, 1.5, 120_001]) {
      reject(changed((value) => { value.timeoutMs = timeoutMs; }));
    }
  });
});
