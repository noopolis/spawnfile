import { vi } from "vitest";
import { DAIMON_GROK_ENGINE_BROKER as broker } from "../../../runtime/daimon/contractManifest.js";
import { parseTrainingBrokerDeclaration } from "../broker/declaration.js";
import { TRAINING_BROKER_DECLARATION_FILE, trainingSlotDescriptors, trainingSlotsDocument } from "../broker/paths.js";
import { resolveTrainingGrokRegistration } from "../broker/registration.js";
import { buildTrainingSlotReceipt } from "../broker/receipt.js";
import type { recycleTrainingSessionSlot } from "./recycle.js";

export const slotFixture = (index = 1, count = 2) => {
  const declaration = parseTrainingBrokerDeclaration({ version: "spawnfile.training-broker.v2", slots: count,
    engine: "grok", agentId: "agent:writer", model: "grok-4.6", reasoningEffort: "low", architecture: "arm64",
    limits: { maxRequests: 20, maxTokens: 10000, timeoutMs: 120000 }, bootstrap: "/run/paideia-auth/grok-bootstrap/auth.json",
    organizationUid: 2000, seccompProfileSha256: "a".repeat(64) });
  const slot = trainingSlotsDocument(count).slots[index]!, p = trainingSlotDescriptors(count)[index]!;
  const registration = resolveTrainingGrokRegistration({ ...declaration, slot: index, slots: count });
  const nonce = "b".repeat(64), projectionSha256 = "c".repeat(64);
  const receipt = buildTrainingSlotReceipt({ slot: index, workerUid: slot.workerUid, generation: 2, nonce, projectionSha256,
    sandboxProfileSha256: registration.profileSha256, seccompProfileSha256: declaration.seccompProfileSha256,
    grokExecutableSha256: broker.grokCliArtifacts.arm64.sha256,
    canaries: registration.denyPaths.map(path => ({ path, method: "sandboxed-read", result: "denied" })), createdAt: new Date() });
  const read = vi.fn(async (file: string) => file === TRAINING_BROKER_DECLARATION_FILE ? declaration : receipt);
  const recycle = vi.fn<typeof recycleTrainingSessionSlot>(async () => ({ ok: true as const, verb: "recycle" as const, slot: index, generation: 2, nonce, receipt: p.preflightReceipt, durationMs: 1 }));
  const projection = vi.fn(async () => ({ projection: { version: broker.projectionVersion }, projectionSha256 }));
  const loadRuntime = vi.fn(async () => ({} as never));
  return { declaration, slot, p, receipt, options: { slot, slots: count, signal: new AbortController().signal, expectedNonce: nonce, minGeneration: 2 },
    dependencies: { read, recycle, projection, loadRuntime } };
};
