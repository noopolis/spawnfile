import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { writeBackTrainingGrokCredential } from "../../../auth/trainingGrokWriteback.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { TRAINING_SLOT_TURN_STORE } from "./paths.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { createTrainingSlotRuntime } from "./runtime.js";
import { createTrainingSlotSupervisor } from "./supervisor.js";

const locations = vi.hoisted(() => new Map<string, string>());
// Redirect only container paths to private fixture files; use the real drain
// and its real journal reads, without requiring root or touching a live realm.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => fs.readFile(locations.get(String(args[0])) ?? args[0], args[1]),
    readdir: (...args: Parameters<typeof fs.readdir>) => fs.readdir(locations.get(String(args[0])) ?? args[0], args[1])
  };
});

// Explicit cross-repository contract test: point at the Daimon checkout under
// review. Ordinary Spawnfile installs do not carry Daimon's TypeScript source.
const daimon = process.env.DAIMON_SOURCE_ROOT;
it.skipIf(!daimon)("restart without refresh permits profile writeback and slot recycling", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "broker-recovery-")));
  try {
    const home = path.join(root, "realm"), turns = path.join(root, "turns");
    await mkdir(home); await mkdir(turns);
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
    const moduleUrl = pathToFileURL(path.join(daimon!, "src/runtime/grokBrokerCredentialAuthority.ts")).href;
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
    locations.set(`${DAIMON_GROK_ENGINE_BROKER.credentialHomePath}/.daimon-broker/credential-journal.json`, journal);
    locations.set(TRAINING_SLOT_TURN_STORE, turns);
    const runtime = createTrainingSlotRuntime({
      declaration: { version: "spawnfile.training-broker.v1", engine: "grok", agentId: "agent:fixture",
        model: "grok-4.6", reasoningEffort: "low", architecture: "arm64", bootstrap: profile,
        organizationUid: 2000, seccompProfileSha256: "a".repeat(64), unenforcedBindPolicy: "refuse",
        limits: { maxRequests: 10, maxTokens: 10000, timeoutMs: 60000 } },
      registration: resolveTrainingGrokRegistration({ agentId: "agent:fixture", model: "grok-4.6", reasoningEffort: "low" }),
      projectionSha256: "a".repeat(64)
    });
    await expect(runtime.drain(AbortSignal.timeout(50))).rejects.toThrow();
    await runAuthority('await new Authority("/nonexistent/grok", home).accessToken(false);');
    // Equal expiry deliberately requires the preserved ancestry proof.
    expect(await writeBackTrainingGrokCredential(profile, auth, journal)).toBe(true);
    expect(await readFile(profile, "utf8")).toBe(await readFile(auth, "utf8"));
    expect(await readFile(profile, "utf8")).not.toBe(original);
    const order: string[] = [];
    // Root-only recycle actions are stubs; the production journal drain and
    // supervisor sequence are real. This is not a live Docker trial.
    const supervisor = createTrainingSlotSupervisor({ drainTimeoutMs: 300, runtime: {
      ...runtime,
      stop: async () => { order.push("stop"); }, wipe: async () => { order.push("wipe"); },
      provision: async () => { order.push("provision"); }, start: async () => { order.push("start"); },
      canaries: async () => [], nextGeneration: async () => 1,
      publishReceipt: async () => { order.push("receipt"); return "fixture-receipt"; }, log: () => undefined
    } });
    await expect(supervisor.recycle("a".repeat(64), 2000)).resolves.toMatchObject({ ok: true, generation: 1 });
    expect(order).toEqual(["stop", "wipe", "provision", "start", "receipt"]);
  } finally { locations.clear(); await rm(root, { recursive: true, force: true }); }
});
