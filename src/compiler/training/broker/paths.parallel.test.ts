import { describe, expect, it } from "vitest";
import path from "node:path";
import { z } from "zod";
import { assertTrainingSlotsDocument, assertTrainingSlotCount, trainingSlotDescriptors, trainingSlotPaths, trainingSlotsDocument, trainingWipeTargets, trainingClearTargets, TRAINING_RUN_REQUEST_STORE, TRAINING_BROKER_SOCKET_PATHS } from "./paths.js";
import { resolveTrainingGrokRegistration, resolveTrainingGrokDenyPaths } from "./registration.js";
import { renderTrainingBrokerProvisioning, renderTrainingSlotProvisioning } from "./provisioning.js";
import { renderDaimonGrokServiceConfig } from "../../containerDaimonGrokWorkerRender.js";
import { trainingBrokerTmpfsTargets } from "../container/security.js";

const registrations = () => trainingSlotDescriptors().map(({ slot }) => resolveTrainingGrokRegistration({
  agentId: "agent:author", model: "grok-4.6", reasoningEffort: "low", slot, slots: 4
}));

describe("four independent training slots", () => {
  it("defaults to four distinct identities, canonical paths, port blocks and clock files", () => {
    const document = trainingSlotsDocument();
    expect(document.schema).toBe("spawnfile.training-slots.v1");
    expect(document.slots).toHaveLength(4);
    expect(document.slots.map(p => p.index)).toEqual([0, 1, 2, 3]);
    expect(document.slots.every(p => p.ports.count === 100)).toBe(true);
    const slots = trainingSlotDescriptors();
    expect(document.slots.map(p => p.workerUid)).toEqual([2200, 2201, 2202, 2203]);
    expect(document.slots.map(p => p.ports.base)).toEqual([20000, 20100, 20200, 20300]);
    for (const field of ["workspace", "runtimeHome", "state", "turns", "usageLedger", "workerHome", "preflightReceipt", "sealedInputsAttestation", "privateTmp", "clockFile"] as const) {
      expect(new Set(slots.map(p => p[field])).size, field).toBe(4);
    }
    for (const p of slots) {
      expect(p.root).toBe(`/run/training/slots/${p.slot}`);
      expect(p.clockFile).toBe(`/run/daimon-engine-broker/task-clock/slot-${p.slot}/faketime`);
      expect(p.ports.workerControl).toBe(p.ports.base + 1);
      expect(p.ports.bridge).toBe(p.ports.base + 2);
    }
  });

  it("rejects invalid counts and indexes, including a valid index outside the pool", () => {
    for (const n of [0, -1, 9, 1.5, NaN, Infinity]) {
      expect(() => assertTrainingSlotCount(n)).toThrow();
      expect(() => trainingSlotDescriptors(n)).toThrow();
    }
    for (const n of [-1, 8, 0.5, NaN, Infinity]) expect(() => trainingSlotPaths(n)).toThrow();
    expect(() => resolveTrainingGrokDenyPaths([], 4, 4)).toThrow(/outside/);
    expect(trainingSlotDescriptors(1)).toHaveLength(1);
    expect(trainingSlotDescriptors(8)).toHaveLength(8);
  });

  it("mandatory sibling masks cannot be removed through an empty custom deny list", () => {
    const slots = trainingSlotDescriptors();
    for (const p of slots) {
      const denied = resolveTrainingGrokDenyPaths([], p.slot, 4);
      expect(denied).toEqual([...denied].sort());
      for (const sibling of slots.filter(other => other.slot !== p.slot)) {
        expect(denied).toContain(sibling.root);
        expect(denied).toContain(sibling.workerHome);
        expect(denied).toContain(sibling.clockDirectory);
      }
      for (const own of [p.workspace, p.runtimeHome, p.workerHome, p.clockFile]) {
        expect(denied.some(d => own === d || own.startsWith(`${d}/`))).toBe(false);
      }
      for (const d of denied) expect(denied.some(other => other !== d && d.startsWith(`${other}/`))).toBe(false);
    }
  });

  it("renders one broker configuration with four repeated-agent registrations and separate policies", () => {
    const rows = registrations();
    for (const row of rows) {
      expect(row.config).toContain("[shell_environment_policy]");
      expect(row.config).toContain(trainingSlotPaths(row.slot).clockFile);
      for (const other of rows.filter(other => other.slot !== row.slot)) expect(row.config).not.toContain(trainingSlotPaths(other.slot).clockFile);
    }
    const config = renderDaimonGrokServiceConfig(rows, { version: "v3", turnStore: "/run/training/turns" });
    expect(config.version).toBe("noopolis.daimon.engine-broker-service.v3");
    expect(config.registrations.map(r => r.agentId)).toEqual(Array(4).fill("agent:author"));
    expect(config.registrations.map(r => r.slot)).toEqual([0, 1, 2, 3]);
    for (const r of config.registrations) expect(Object.keys(r).sort()).toEqual(["agentId", "slot", "workerUid", "workspace", "profilePath", "eventsPath", "profileSha256"].sort());
    expect(config.slotPolicies?.map(p => p.usageLedgerPath)).toEqual(rows.map(r => r.usageLedgerPath));
    const script = renderTrainingBrokerProvisioning(rows, 17).join("\n");
    const serviceLine = script.split("\n").find(line => line.startsWith("const service = "))!;
    expect(JSON.parse(serviceLine.slice("const service = ".length, -1)).maxRunRequests).toBe(17);
    expect(JSON.parse(serviceLine.slice("const service = ".length, -1)).runRequestStore).toBe(TRAINING_RUN_REQUEST_STORE);
    const start = script.indexOf("node <<'SPAWNFILE_DAIMON_BROKER_PROVISION'");
    for (const socket of TRAINING_BROKER_SOCKET_PATHS) {
      expect(script).toContain(JSON.stringify(socket));
      expect(script).not.toContain(`touch '${socket}'`);
      expect(script).not.toContain(`rm '${socket}'`);
    }
    expect(script).toContain('unsafe broker socket placeholder');
    for (const p of trainingSlotDescriptors()) {
      expect(script.indexOf(`mkdir -p '${p.clockDirectory}'`)).toBeGreaterThanOrEqual(0);
      expect(script.indexOf(`mkdir -p '${p.clockDirectory}'`)).toBeLessThan(start);
    }
    expect(script.match(/const registrations = /g)).toHaveLength(1);
    expect(script.match(/const service = /g)).toHaveLength(1);
    expect(script).toContain("worker.slot === registration.slot");
    for (const p of trainingSlotDescriptors()) {
      expect(resolveTrainingGrokDenyPaths([], p.slot, 4)).toContain(TRAINING_RUN_REQUEST_STORE);
      expect([...trainingWipeTargets(p.slot), ...trainingClearTargets(p.slot)].some(root =>
        TRAINING_RUN_REQUEST_STORE === root || TRAINING_RUN_REQUEST_STORE.startsWith(`${root}/`))).toBe(false);
      expect(script).toContain(p.clockFile);
      expect(script).toContain(p.sealedInputsAttestation);
    }
  });

  it("reprovisions only the selected worker without touching shared service, realm, home or temp identities", () => {
    const script = renderTrainingSlotProvisioning(registrations()[1]!).join("\n");
    expect(script).not.toContain("const service =");
    expect(script).not.toContain("const shared of");
    expect(script).not.toContain("ensureDirectory(entry.home,");
    expect(script).not.toContain("ensureDirectory(entry.privateTmp,");
    expect(script).not.toContain("credential-journal");
    expect(script).toContain(trainingSlotPaths(1).sealedInputsAttestation);
    expect(script).not.toContain(trainingSlotPaths(0).sealedInputsAttestation);
    expect(script).toContain('"slot":1');
    expect(script).not.toContain('"slot":0');
  });

  it("keeps every mount outside every slot wipe target and descendant of a clear target", () => {
    const mounts = trainingBrokerTmpfsTargets(4).map(p => p.path);
    for (const p of trainingSlotDescriptors()) {
      expect(mounts).toContain(p.root);
      for (const target of trainingWipeTargets(p.slot)) expect(mounts.some(m => m === target || m.startsWith(`${target}/`))).toBe(false);
      for (const target of trainingClearTargets(p.slot)) expect(mounts.some(m => m !== target && m.startsWith(`${target}/`))).toBe(false);
      expect(trainingWipeTargets(p.slot)).not.toContain(p.workerHome);
      expect(trainingWipeTargets(p.slot)).not.toContain(p.privateTmp);
    }
  });
});

it("publishes Paideia's strict runtime-neutral descriptor shape with every detailed path preserved", () => {
  const consumerContract = z.strictObject({ schema: z.literal("spawnfile.training-slots.v1"), slots: z.array(z.strictObject({
    index: z.number().int().min(0).max(7), workerUid: z.number().int().positive(),
    roots: z.record(z.string().min(1), z.string().refine(path.isAbsolute)),
    ports: z.strictObject({ base: z.number().int().min(1024).max(65535), count: z.number().int().positive() })
  })).min(1).max(8) });
  const document = trainingSlotsDocument();
  expect(consumerContract.parse(document)).toEqual(document);
  for (const descriptor of trainingSlotDescriptors()) {
    const slot = document.slots[descriptor.slot]!;
    expect(slot.roots.workspace).toBe(descriptor.workspace);
    expect(slot.roots.home).toBe(descriptor.runtimeHome);
    expect(slot.roots.control).toBe(descriptor.state);
    expect(slot.roots.clockFile).toBe(descriptor.clockFile);
    for (const [index, entry] of descriptor.evaluatorPaths.entries()) expect(slot.roots[`evaluator:${entry.role}:${index}`]).toBe(entry.path);
    for (const [index, entry] of descriptor.containerPaths.entries()) expect(slot.roots[`container:${index}`]).toBe(entry.path);
  }
});

it("refuses an edited, stale or extra-member slots bind before provisioning", () => {
  const document = trainingSlotsDocument(4);
  expect(() => assertTrainingSlotsDocument(document, 4)).not.toThrow();
  expect(() => assertTrainingSlotsDocument(document, 3)).toThrow(/differs/);
  expect(() => assertTrainingSlotsDocument({ ...document, extra: true }, 4)).toThrow(/differs/);
  document.slots[1]!.roots.workspace = document.slots[0]!.roots.workspace!;
  expect(() => assertTrainingSlotsDocument(document, 4)).toThrow(/differs/);
});
