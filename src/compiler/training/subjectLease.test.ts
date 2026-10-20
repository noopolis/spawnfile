import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { DAIMON_GROK_ENGINE_BROKER } from "../../runtime/daimon/contractManifest.js";
import { resolveDaimonGrokClockedWorkerConfig } from "../../runtime/daimon/grokWorkerContract.js";
import { parseTrainingBrokerDeclaration } from "./broker/declaration.js";
import { trainingSlotPaths } from "./broker/paths.js";
import { resolveTrainingGrokProjection, type DaimonProjectionModule } from "./broker/projection.js";
import { buildTrainingSlotReceipt } from "./broker/receipt.js";
import { resolveTrainingGrokRegistration } from "./broker/registration.js";
import { TRAINING_SUPERVISOR_PROTOCOL } from "./broker/supervisor.js";
import { leaseTrainingSubject, TRAINING_CODEX_CREDENTIAL_INGRESS, type LeaseTrainingSubjectOptions } from "./subjectLease.js";

const broker = DAIMON_GROK_ENGINE_BROKER;
const nonce = "e".repeat(64);
const servers: Server[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = (): string => {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? "/private/tmp", "sfl-"));
  roots.push(root);
  return root;
};

const declarationInput = (slots: number) => ({
  version: "spawnfile.training-broker.v2", slots, engine: "grok", agentId: "agent:reporter", model: "grok-4.6", reasoningEffort: "high",
  architecture: "arm64", limits: { maxRequests: 48, maxTokens: 2_500_000, timeoutMs: 1_800_000 },
  bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth", organizationUid: 2000, seccompProfileSha256: "a".repeat(64)
});

/** Daimon's resolver, stubbed over the inputs it actually reads; a digest of everything it returns. */
const daimon: DaimonProjectionModule = {
  GROK_ENGINE_BROKER: broker,
  resolveOrganizationGrokBrokerProjection: (config, _agentId, options) => {
    const slot = options.slot as number, clock = broker.worker.taskClock;
    return {
      version: broker.projectionVersion, denyPaths: options.denyPaths as string[], profileSha256: options.profileSha256 as string,
      workerConfigVariant: options.workerConfigVariant, workerConfigSha256: resolveDaimonGrokClockedWorkerConfig("grok-4.6", "high", slot).sha256,
      taskClock: { ...clock, directoryPath: clock.slotDirectoryPattern.replace("{slot}", String(slot)),
        timestampFilePath: clock.slotFilePattern.replace("{slot}", String(slot)) },
      config, options
    } as unknown as ReturnType<DaimonProjectionModule["resolveOrganizationGrokBrokerProjection"]>;
  },
  grokBrokerProjectionSha256: (projection) => createHash("sha256").update(JSON.stringify(projection)).digest("hex")
};

/** A supervisor stand-in that records the request and answers with whatever the test says. */
const supervisor = async (answer: (request: { slot: number; nonce: string }) => Record<string, unknown>) => {
  const socket = path.join(scratch(), "c.sock"), requests: { slot: number; nonce: string }[] = [];
  const server = createServer((peer) => peer.once("data", (chunk) => {
    const request = JSON.parse(chunk.toString("utf8")) as { slot: number; nonce: string };
    requests.push(request);
    peer.end(`${JSON.stringify({ v: TRAINING_SUPERVISOR_PROTOCOL, ...answer(request) })}\n`);
  }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { connect: () => createConnection(socket), requests };
};
const recycled = (generation = 5) => (request: { slot: number; nonce: string }) => ({ ok: true, verb: "recycle", slot: request.slot,
  generation, nonce: request.nonce, receipt: trainingSlotPaths(request.slot).preflightReceipt, durationMs: 610 });

const grok = async (overrides: Partial<LeaseTrainingSubjectOptions> = {}, slots = 4, answer = recycled()) => {
  const declarationFile = path.join(scratch(), "training-broker.json");
  writeFileSync(declarationFile, JSON.stringify(declarationInput(slots)));
  const peer = await supervisor(answer);
  const options: LeaseTrainingSubjectOptions = { slot: 2, engine: "grok", agentId: "agent:reporter", signal: new AbortController().signal,
    freshness: { expectedNonce: nonce, minGeneration: 5 }, loadDaimon: async () => daimon, connect: peer.connect, declarationFile, ...overrides };
  return { lease: () => leaseTrainingSubject(options), peer, declaration: parseTrainingBrokerDeclaration(declarationInput(slots)) };
};

// Paideia 0.1.1 `grokBrokerLaunchSchema` and its `assertGrokBroker` checks, restated structurally (not a dependency).
const nativePath = z.string().refine((value) => path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.includes(","));
const digest = z.string().regex(/^[a-f0-9]{64}$/u), positive = z.number().int().positive();
const roles = ["run-root", "context", "sealed-inputs", "judge-home", "slot-ledger"] as const;
const paideiaBroker = z.strictObject({
  projectionVersion: z.literal("noopolis.daimon.grok-broker-projection.v3"), workerConfigVariant: z.enum(["unclocked", "clocked"]),
  projectionSha256: digest, slot: z.number().int().min(0), workerUid: z.number().int().min(2200).max(4_294_967_294), workerHomePath: nativePath,
  architecture: z.enum(["arm64", "x64"]), usageLedgerPath: nativePath, seccompProfileSha256: digest, profileSha256: digest,
  denyPaths: z.array(nativePath).min(1).max(64), limits: z.strictObject({ maxRequests: positive, maxTokens: positive, timeoutMs: positive }),
  evaluatorPaths: z.array(z.strictObject({ role: z.enum(roles), path: nativePath })).min(roles.length).max(64),
  slotPreflightReceipt: nativePath, expectedNonce: digest, minGeneration: z.number().int().min(1)
});
const nested = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}/`);

describe("leaseTrainingSubject for a brokered Grok slot", () => {
  it("recycles the leased slot with the evaluator's nonce and returns a Paideia-valid broker section", async () => {
    const { lease, peer } = await grok();
    const result = await lease();
    expect(peer.requests).toEqual([{ v: TRAINING_SUPERVISOR_PROTOCOL, verb: "recycle", slot: 2, nonce }]);
    const section = paideiaBroker.parse(result.broker);
    const subject = [result.workspace.target, ...result.projections.map((row) => row.target)];
    const denied = new Set(section.denyPaths);
    expect(section.evaluatorPaths.filter((row) => !denied.has(row.path))).toEqual([]);
    expect(roles.filter((role) => !section.evaluatorPaths.some((row) => row.role === role))).toEqual([]);
    expect(section.evaluatorPaths.find((row) => row.role === "slot-ledger")!.path).toBe(path.posix.dirname(section.usageLedgerPath));
    expect(section.evaluatorPaths.some((row) => subject.some((target) => nested(row.path, target) || nested(target, row.path)))).toBe(false);
    expect(new Set(section.denyPaths).size).toBe(section.denyPaths.length);
    const p = trainingSlotPaths(2);
    expect(result).toMatchObject({
      agent: { id: "agent:reporter", engine: "grok", model: "grok-4.6", reasoningEffort: "high" },
      workspace: { source: p.workspace, target: p.workspace },
      projections: [{ role: "home", source: p.runtimeHome, target: p.runtimeHome }], credentials: [], generation: 5,
      roots: { workspace: p.workspace, home: p.runtimeHome, control: p.state, workerHome: p.workerHome, usageLedger: p.usageLedger,
        preflightReceipt: p.preflightReceipt, context: "/run/paideia" },
      ports: { moltnet: 20_200, workerControl: 20_201, bridge: 20_202 }, env: { DAIMON_ENGINE_BROKER_SLOT: "2" }
    });
    expect(section).toMatchObject({ slot: 2, workerUid: 2202, workerConfigVariant: "clocked", expectedNonce: nonce, minGeneration: 5,
      limits: { maxRequests: 48, maxTokens: 2_500_000, timeoutMs: 1_800_000 }, slotPreflightReceipt: p.preflightReceipt });
  });

  it("hands Paideia the projection digest the supervisor bound into this slot's receipt", async () => {
    for (const [slots, slot] of [[1, 0], [4, 2], [8, 7]] as const) {
      const { lease, declaration } = await grok({ slot }, slots);
      const result = await lease();
      // What the root entrypoint computes for the same slot, independently of the lease.
      const registration = resolveTrainingGrokRegistration({ ...declaration, slot });
      const bound = await resolveTrainingGrokProjection(declaration, registration, daimon);
      expect(result.broker!.projectionSha256).toBe(bound.projectionSha256);
      expect(result.broker!.denyPaths).toEqual(registration.denyPaths);
      expect(result.broker!.profileSha256).toBe(registration.profileSha256);
      const receipt = buildTrainingSlotReceipt({ slot, workerUid: registration.uid, generation: 5, nonce, projectionSha256: bound.projectionSha256,
        sandboxProfileSha256: registration.profileSha256, seccompProfileSha256: declaration.seccompProfileSha256,
        grokExecutableSha256: broker.grokCliArtifacts.arm64.sha256, canaries: [{ path: "/run/paideia", method: "sandboxed-read", result: "denied" }],
        createdAt: new Date(0) });
      expect(receipt.projection_sha256).toBe(result.broker!.projectionSha256);
      // Each slot denies its siblings, so registrations differ across a multi-slot pool.
      if (slots > 1) expect(result.broker!.denyPaths).toContain(trainingSlotPaths(0).root);
    }
  });

  it("refuses a receipt outside the leased slot and a generation below the floor", async () => {
    const elsewhere = await grok({}, 4, (request) => ({ ...recycled()(request), receipt: trainingSlotPaths(1).preflightReceipt }));
    await expect(elsewhere.lease()).rejects.toThrow(/outside the leased slot root/u);
    const stale = await grok({ freshness: { expectedNonce: nonce, minGeneration: 6 } });
    await expect(stale.lease()).rejects.toThrow(/below the evaluator freshness floor/u);
    const another = await grok({}, 4, (request) => ({ ...recycled()(request), slot: 3 }));
    await expect(another.lease()).rejects.toThrow(/names slot 3, not the leased slot 2/u);
  });

  it("refuses slot, agent, model, freshness and Daimon mismatches before recycling", async () => {
    for (const [overrides, message] of [
      [{ slot: 4 }, /outside the declared pool of 4/u],
      [{ agentId: "agent:editor" }, /declares agent:reporter, not agent:editor/u],
      [{ model: "grok-4.5" }, /declares model grok-4.6/u],
      [{ freshness: undefined }, /requires freshness/u],
      [{ freshness: { expectedNonce: "E".repeat(64), minGeneration: 1 } }, /requires freshness/u],
      [{ freshness: { expectedNonce: nonce, minGeneration: 0 } }, /requires freshness/u],
      [{ loadDaimon: async () => ({ ...daimon, GROK_ENGINE_BROKER: { ...broker, projectionVersion: "old" } }) }, /differs from this compiler/u]
    ] as const) {
      const { lease, peer } = await grok(overrides as Partial<LeaseTrainingSubjectOptions>);
      await expect(lease()).rejects.toThrow(message);
      expect(peer.requests).toEqual([]);
    }
  });

  it("refuses an aborted lease before touching the slot", async () => {
    const controller = new AbortController();
    controller.abort(Error("trial cancelled"));
    const { lease, peer } = await grok({ signal: controller.signal });
    await expect(lease()).rejects.toThrow(/trial cancelled/u);
    expect(peer.requests).toEqual([]);
  });
});

describe("leaseTrainingSubject for a Codex subject", () => {
  const material = { ENGINE_CREDENTIAL_MATERIAL: { codex: { sourceRelativePath: ".daimon-inbound/codex-auth" } } };
  const codex = (overrides: Partial<LeaseTrainingSubjectOptions> = {}) => leaseTrainingSubject({ slot: 1, engine: "codex", agentId: "agent:reporter",
    model: "gpt-5.5", signal: new AbortController().signal, loadDaimon: async () => material,
    trialRoots: { workspace: "/work/trial-1/workspace", runtimeHome: "/work/trial-1/runtime" }, ...overrides });

  it("projects home, memory and transport and binds the credential ingress into the home", async () => {
    await expect(codex()).resolves.toEqual({
      agent: { id: "agent:reporter", engine: "codex", model: "gpt-5.5" },
      workspace: { source: "/work/trial-1/workspace", target: "/work/trial-1/workspace" },
      projections: [{ role: "home", source: "/work/trial-1/home", target: "/work/trial-1/home" },
        { role: "memory", source: "/work/trial-1/memory", target: "/work/trial-1/memory" },
        { role: "transport", source: "/work/trial-1/runtime/native/moltnet", target: "/work/trial-1/runtime/native/moltnet" }],
      credentials: [{ source: TRAINING_CODEX_CREDENTIAL_INGRESS, target: "/work/trial-1/home/.daimon-inbound/codex-auth" }],
      roots: { workspace: "/work/trial-1/workspace", home: "/work/trial-1/home", memory: "/work/trial-1/memory",
        transport: "/work/trial-1/runtime/native/moltnet", control: "/work/trial-1/runtime/native/root-control/acceptance",
        inputs: "/work/trial-1/runtime/native/root-control/inputs" },
      ports: { moltnet: 20_100, workerControl: 20_101, bridge: 20_102 }, env: {}
    });
    expect(TRAINING_CODEX_CREDENTIAL_INGRESS).toBe("/run/paideia-auth/codex");
  });

  it("refuses drifted Daimon credential material, missing inputs and freshness", async () => {
    await expect(codex({ loadDaimon: async () => ({ ENGINE_CREDENTIAL_MATERIAL: { codex: { sourceRelativePath: ".codex/auth.json" } } }) }))
      .rejects.toThrow(/credential material differs/u);
    await expect(codex({ loadDaimon: async () => { throw Error("missing"); } })).rejects.toThrow(/must install @noopolis\/daimon/u);
    await expect(codex({ model: " " })).rejects.toThrow(/compiled model/u);
    await expect(codex({ trialRoots: undefined })).rejects.toThrow(/trial roots/u);
    await expect(codex({ trialRoots: { workspace: "work/w", runtimeHome: "/r" } })).rejects.toThrow(/canonical absolute path/u);
    await expect(codex({ trialRoots: { workspace: "/w/x", runtimeHome: "/w/x/r" } })).rejects.toThrow(/overlap the subject workspace/u);
    await expect(codex({ freshness: { expectedNonce: nonce, minGeneration: 1 } })).rejects.toThrow(/freshness does not apply/u);
  });
});

it("refuses an unknown engine and an invalid slot", async () => {
  const signal = new AbortController().signal;
  await expect(leaseTrainingSubject({ slot: 0, engine: "agy", agentId: "agent:a", signal })).rejects.toThrow(/engine agy is not supported/u);
  await expect(leaseTrainingSubject({ slot: -1, engine: "codex", agentId: "agent:a", signal })).rejects.toThrow(/slot index/u);
});
