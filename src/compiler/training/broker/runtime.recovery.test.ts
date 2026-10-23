import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { writeBackTrainingGrokCredential } from "../../../auth/trainingGrokWriteback.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { parseTrainingBrokerDeclaration } from "./declaration.js";
import { resetTrainingBrokerSlot } from "./reset.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { createTrainingSlotRuntime } from "./runtime.js";
import { createTrainingSlotSupervisor } from "./supervisor.js";

const transport = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", async importOriginal => ({
  ...await importOriginal<typeof import("node:net")>(), createConnection: transport.connect
}));

// Exercise real v4 request/ack validation and v2 runtime/supervisor. The socket,
// native active-turn gate and root-only recycle actions are portable stand-ins.
const slotPool = async (profile: string) => {
  const active = new Set<number>(), requests: number[] = [];
  transport.connect.mockImplementation((socketPath: string) => {
    expect(socketPath).toBe(DAIMON_GROK_ENGINE_BROKER.controlSocketPath);
    const socket = new EventEmitter();
    Object.assign(socket, { destroy: () => socket.emit("close"), write: (frame: Buffer) => {
      expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
      const request = JSON.parse(frame.subarray(4).toString("utf8"));
      expect(request).toEqual({ version: DAIMON_GROK_ENGINE_BROKER.controlProtocolVersion,
        kind: "reset_slot", requestId: expect.any(String), slot: expect.any(Number) });
      requests.push(request.slot);
      if (active.has(request.slot)) { socket.emit("close"); return; }
      const body = Buffer.from(JSON.stringify({ version: request.version, kind: "slot_reset",
        requestId: request.requestId, slot: request.slot }));
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
      socket.emit("data", header); socket.emit("data", body);
    } });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  const declaration = parseTrainingBrokerDeclaration({ version: "spawnfile.training-broker.v2", slots: 2,
    engine: "grok", agentId: "agent:fixture", model: "grok-4.6", reasoningEffort: "low", architecture: "arm64",
    bootstrap: profile, organizationUid: 2000, seccompProfileSha256: "a".repeat(64),
    limits: { maxRequests: 10, maxTokens: 10000, timeoutMs: 60000 } });
  const order: string[][] = [[], []];
  const runtimes = order.map((steps, slot) => {
    const runtime = createTrainingSlotRuntime({ declaration,
      registration: resolveTrainingGrokRegistration({ ...declaration, slot }), projectionSha256: "a".repeat(64),
      reset: async (index, signal) => { await resetTrainingBrokerSlot(index, signal); steps.push("reset"); }
    });
    return { ...runtime,
      wipe: vi.fn(async () => { steps.push("wipe"); }), provision: vi.fn(async () => { steps.push("provision"); }),
      canaries: async () => [], nextGeneration: async () => 1,
      publishReceipt: async () => { steps.push("receipt"); return `fixture-receipt-${slot}`; }, log: () => undefined
    };
  });
  return { active, requests, order, supervisor: createTrainingSlotSupervisor({ runtimes, drainTimeoutMs: 1000 }) };
};

it("recycles a leased slot beside an active sibling without draining or modifying the shared credential journal", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "broker-slots-")));
  const profile = path.join(root, "profile"), journal = path.join(root, "journal"), auth = path.join(root, "auth");
  const original = JSON.stringify({ "https://auth.x.ai::fixture": {
    key: "synthetic", refresh_token: "synthetic", expires_at: "2030-01-01T00:00:00Z" } });
  const refreshed = original.replaceAll("synthetic", "synthetic-renewed");
  const pending = JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1",
    state: "refreshing", generation: 1, sourceDigest: "a".repeat(64) });
  let pool: Awaited<ReturnType<typeof slotPool>> | undefined;
  try {
    await writeFile(profile, original, { mode: 0o600 }); await writeFile(auth, refreshed, { mode: 0o600 });
    await writeFile(journal, pending, { mode: 0o600 });
    pool = await slotPool(profile); pool.active.add(0); pool.active.add(1);
    await expect(pool.supervisor.recycle(1, "a".repeat(64), 2000)).rejects.toThrow(/slot active/);
    expect(pool.order).toEqual([[], []]);
    pool.active.delete(1);
    await expect(pool.supervisor.recycle(1, "b".repeat(64), 2000)).resolves.toMatchObject({ ok: true, slot: 1 });
    expect(pool.requests).toEqual([1, 1]);
    expect(pool.order).toEqual([[], ["reset", "wipe", "provision", "receipt"]]);
    expect(pool.active.has(0)).toBe(true);
    // Slot reset is independent of credential recovery; unsettled auth still cannot be exported.
    await expect(writeBackTrainingGrokCredential(profile, auth, journal)).rejects.toThrow(/writeback failed/);
    expect(await readFile(profile, "utf8")).toBe(original);
    expect(await readFile(auth, "utf8")).toBe(refreshed);
    expect(await readFile(journal, "utf8")).toBe(pending);
  } finally { transport.connect.mockReset(); await rm(root, { recursive: true, force: true }); }
});

// Read the broker as test data from its exact registry revision, never from a
// checkout's mutable HEAD. CI supplies the repository; local runs may select it
// with DAIMON_SOURCE_ROOT. Missing source is a failure in CI, optional locally.
const stagePinnedDaimon = async (root: string): Promise<string> => {
  const registry = parseYaml(await readFile("runtimes.yaml", "utf8")) as {
    runtimes: { daimon: { ref: string } }
  };
  const ref = registry.runtimes.daimon.ref;
  if (!/^[a-f0-9]{40}$/u.test(ref)) throw Error("Daimon recovery requires a full registry commit pin");
  const source = process.env.DAIMON_SOURCE_ROOT;
  if (!source) throw Error("Daimon recovery requires Git source; set DAIMON_SOURCE_ROOT");
  const run = promisify(execFile);
  let revision: string;
  try { revision = (await run("git", ["-C", source, "rev-parse", `${ref}^{commit}`])).stdout.trim(); }
  catch { throw Error(`Daimon recovery requires Git source containing ${ref}; set DAIMON_SOURCE_ROOT`); }
  expect(revision).toBe(ref);
  const archive = path.join(root, "daimon.tar"), staged = path.join(root, "daimon");
  await mkdir(staged);
  await run("git", ["-C", source, "archive", "--format=tar", `--output=${archive}`, ref, "src", "package.json"]);
  await run("tar", ["-xf", archive, "-C", staged]);
  await symlink(path.resolve("node_modules"), path.join(staged, "node_modules"), "dir");
  return staged;
};

it.skipIf(!process.env.CI && !process.env.DAIMON_SOURCE_ROOT)("restart without refresh permits profile writeback and slot recycling at the exact Daimon pin", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "broker-recovery-")));
  let pool: Awaited<ReturnType<typeof slotPool>> | undefined;
  try {
    const daimon = await stagePinnedDaimon(root);
    const home = path.join(root, "realm");
    await mkdir(home);
    const auth = path.join(home, "auth.json"), profile = path.join(root, "profile.json");
    const journal = path.join(home, ".daimon-broker", "credential-journal.json");
    const original = JSON.stringify({ "https://auth.x.ai::fixture": {
      key: "a".repeat(40), refresh_token: "r".repeat(20), expires_at: "2030-01-01T00:00:00Z"
    } });
    await writeFile(profile, original, { mode: 0o600 });
    await writeFile(auth, original, { mode: 0o600 });
    const command = path.join(root, "rotate.cjs");
    await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const file = path.join(process.env.GROK_HOME, "auth.json");
const auth = JSON.parse(fs.readFileSync(file, "utf8"));
Object.values(auth)[0].key = "b".repeat(40);
fs.writeFileSync(file, JSON.stringify(auth));
`, { mode: 0o700 });
    const moduleUrl = pathToFileURL(path.join(daimon, "src/engines/grok/broker/grokBrokerCredentialAuthority.ts")).href;
    // Two processes model the crash/restart boundary. No credential bytes are
    // returned in stdout; the second process cannot invoke a refresh command.
    const runAuthority = async (body: string) => promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", `
import { DurableGrokBrokerCredentialAuthority as Authority } from ${JSON.stringify(moduleUrl)};
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const home = ${JSON.stringify(home)}, auth = ${JSON.stringify(auth)}, journal = ${JSON.stringify(journal)};
${body}`], { cwd: daimon, timeout: 15_000, env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
    await runAuthority(`
await new Authority(${JSON.stringify(command)}, home).accessToken(true);
const row = JSON.parse(await readFile(journal, "utf8"));
row.state = "refreshing";
row.sourceDigest = createHash("sha256").update(await readFile(auth)).digest("hex");
delete row.promotedDigest;
await writeFile(journal, JSON.stringify(row));`);
    expect(JSON.parse(await readFile(journal, "utf8")).state).toBe("refreshing");
    await expect(writeBackTrainingGrokCredential(profile, auth, journal)).rejects.toThrow(/writeback failed/);
    await runAuthority('await new Authority("/nonexistent/grok", home).accessToken(false);');
    expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({ state: "promoted", generation: 1 });
    // Equal expiry deliberately requires the preserved ancestry proof.
    expect(await writeBackTrainingGrokCredential(profile, auth, journal)).toBe(true);
    expect(await readFile(profile, "utf8")).toBe(await readFile(auth, "utf8"));
    expect(await readFile(profile, "utf8")).not.toBe(original);
    pool = await slotPool(profile); pool.active.add(0);
    const settled = await readFile(journal, "utf8"), refreshed = await readFile(auth, "utf8");
    await expect(pool.supervisor.recycle(1, "a".repeat(64), 2000)).resolves.toMatchObject({ ok: true, slot: 1, generation: 1 });
    expect(pool.requests).toEqual([1]);
    expect(pool.order).toEqual([[], ["reset", "wipe", "provision", "receipt"]]);
    expect(await readFile(journal, "utf8")).toBe(settled);
    expect(await readFile(auth, "utf8")).toBe(refreshed);
  } finally { transport.connect.mockReset(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(!process.env.CI && !process.env.DAIMON_SOURCE_ROOT)("two equal-expiry rotations across restart retain ancestry to the original host credential at the exact Daimon pin", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "broker-lineage-")));
  try {
    const daimon = await stagePinnedDaimon(root), home = path.join(root, "realm");
    await mkdir(home);
    const auth = path.join(home, "auth.json"), profile = path.join(root, "profile.json");
    const journal = path.join(home, ".daimon-broker", "credential-journal.json");
    const original = JSON.stringify({ "https://auth.x.ai::fixture": {
      key: "a".repeat(40), refresh_token: "r".repeat(20), expires_at: "2030-01-01T00:00:00Z"
    } });
    await writeFile(profile, original, { mode: 0o600 });
    await writeFile(auth, original, { mode: 0o600 });
    const command = path.join(root, "rotate.cjs");
    await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const file = path.join(process.env.GROK_HOME, "auth.json");
const auth = JSON.parse(fs.readFileSync(file, "utf8")), row = Object.values(auth)[0];
row.key = String.fromCharCode(row.key.charCodeAt(0) + 1).repeat(40);
fs.writeFileSync(file, JSON.stringify(auth));
`, { mode: 0o700 });
    const moduleUrl = pathToFileURL(path.join(daimon, "src/engines/grok/broker/grokBrokerCredentialAuthority.ts")).href;
    // Each rotation gets a fresh process, so lineage must survive on disk.
    for (let generation = 1; generation <= 2; generation++) {
      await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
import { DurableGrokBrokerCredentialAuthority as Authority } from ${JSON.stringify(moduleUrl)};
await new Authority(${JSON.stringify(command)}, ${JSON.stringify(home)}).accessToken(true);
`], { cwd: daimon, timeout: 15_000, env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
      expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({ state: "promoted", generation });
    }
    const row = JSON.parse(await readFile(journal, "utf8"));
    const { createHash } = await import("node:crypto");
    const originalDigest = createHash("sha256").update(original).digest("hex");
    expect(row.sourceDigest).not.toBe(originalDigest);
    expect(row.ancestorDigests).toContain(originalDigest);
    expect(await writeBackTrainingGrokCredential(profile, auth, journal)).toBe(true);
    expect(await readFile(profile, "utf8")).toBe(await readFile(auth, "utf8"));
    expect(await readFile(profile, "utf8")).not.toBe(original);
    expect(await writeBackTrainingGrokCredential(profile, auth, journal)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
