import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import type { PreparedTrial, TrialWake } from "./boot.js";
import { createBootedTrialRun } from "./launcher.js";
import type { RealmTurns } from "./realmTurns.js";

const profile = (realms?: ResolvedAuthProfile["realms"]): ResolvedAuthProfile => ({
  authHome: "/nonexistent", env: { SECRET: "x" }, imports: { codex: { kind: "codex", path: "/nonexistent/codex" } }, name: "training",
  profileDirectory: "/nonexistent/training", profilePath: "/nonexistent/training/profile.json", version: 1,
  ...(realms ? { realms } : {})
});
const AGY = { homeVolume: "spawnfile-training-training-agy-home", realmVolume: "spawnfile-training-training-agy-realm", unlockVolume: "spawnfile-training-training-agy-unlock" };

const wakeResult: TrialWake = { state: "completed", acceptanceId: "a", executionId: "e", code: null, text: "{}", usage: [], transcript: null, requestToolCalls: [[]], failure: null };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Fake organizations on the AGY engine that record how many containers hold the realm at once. */
const harness = (authProfile = profile({ agy: AGY }), turns?: RealmTurns) => {
  const events: string[] = [];
  const boots: Array<{ gateway: unknown; realms: ResolvedAuthProfile | undefined; evidenceDirectory: string }> = [];
  let active = 0;
  let maxActive = 0;
  const prepare = async (input: { trialId: string }): Promise<PreparedTrial> => ({
    agentId: input.trialId, engines: ["agy"], image: `image-${input.trialId}`, runtimeRoot: "/opt/runtime",
    dispose: async () => { events.push(`dispose ${input.trialId.split("-")[0]}`); },
    login: async () => [],
    boot: async (gateway, options) => {
      boots.push({ gateway, realms: options.realms, evidenceDirectory: options.evidenceDirectory });
      active++; maxActive = Math.max(maxActive, active);
      const name = input.trialId.split("-")[0]!;
      events.push(`boot ${name}`);
      await tick();
      return {
        container: `c-${name}`, scanCredentials: async () => [], read: async () => null,
        wake: async () => { await tick(); return wakeResult; },
        teardown: async () => { await tick(); active--; events.push(`down ${name}`); return `last failure of ${name}`; }
      };
    }
  });
  const run = createBootedTrialRun({
    agentManifestPath: "/nonexistent/Spawnfile", authProfile, scratchRoot: path.join(os.tmpdir(), "spawnfile-launcher-test"),
    docker: async () => "", prepare: prepare as never, ...(turns ? { turns } : {})
  });
  return { boots, events, run, maxActive: () => maxActive };
};

it("boots AGY trials one at a time on a profile's login and never reaches the realm lock twice", async () => {
  const { boots, events, maxActive, run } = harness();
  const [first, second] = await Promise.all([
    run.boot({ trialId: "one", instructions: "i" }).then(async (trial) => { await tick(); await trial.teardown(); }),
    run.boot({ trialId: "two", instructions: "i" }).then((trial) => trial.teardown())
  ]);
  expect([first, second]).toEqual([undefined, "last failure of two"]);
  expect(maxActive()).toBe(1);
  const lifecycle = events.filter((event) => !event.startsWith("dispose"));
  expect(lifecycle.map((event) => event.split(" ")[0])).toEqual(["boot", "down", "boot", "down"]);
  expect(lifecycle[0]!.split(" ")[1]).toBe(lifecycle[1]!.split(" ")[1]);
  // No gateway for an engine that is not gatewayed; the login is the only profile content the trial sees.
  expect(boots[0]).toEqual({ gateway: null, realms: expect.objectContaining({ env: {}, imports: {}, realms: { agy: AGY } }),
    evidenceDirectory: expect.stringContaining(path.join("evidence", "trial-")) });
  await run.close();
});

it("fails the serialization guarantee without turns (mutation check)", async () => {
  const noTurns: RealmTurns = { take: async () => () => undefined };
  const { maxActive, run } = harness(undefined, noTurns);
  await Promise.all(["one", "two"].map((trialId) => run.boot({ trialId, instructions: "i" }).then((trial) => trial.teardown())));
  expect(maxActive()).toBe(2);
});

it("keeps the AGY judge warm until a trial waits, then hands the login over and takes it back", async () => {
  const { events, maxActive, run } = harness();
  const judge = await run.judge({ engine: "agy", model: "default" });
  await judge.wake("first", { deliveryId: "d1", timeoutMs: 1_000 });
  await judge.wake("second", { deliveryId: "d2", timeoutMs: 1_000 });
  expect(events.filter((event) => event.startsWith("boot judge"))).toHaveLength(1);
  const trial = await run.boot({ trialId: "trial", instructions: "i" });
  expect(events).toContain("down judge");
  const later = judge.wake("third", { deliveryId: "d3", timeoutMs: 1_000 });
  await tick(); await tick();
  expect(events.at(-1)).toBe("boot trial");
  await trial.teardown();
  await expect(later).resolves.toMatchObject({ state: "completed" });
  expect(maxActive()).toBe(1);
  await run.close();
  expect(events.slice(-2)).toEqual(["down judge", "dispose judge"]);
});

it("refuses an AGY organization when the profile holds no AGY login", async () => {
  const { run } = harness(profile());
  await expect(run.boot({ trialId: "one", instructions: "i" })).rejects.toThrow("run `spawnfile auth login agy --profile training`");
  await expect(run.judge({ engine: "agy", model: "default" })).rejects.toThrow("spawnfile auth login agy");
});

it("refuses an AGY login recorded before its home login files were kept", async () => {
  const { run } = harness(profile({ agy: { realmVolume: AGY.realmVolume, unlockVolume: AGY.unlockVolume } }));
  await expect(run.boot({ trialId: "one", instructions: "i" })).rejects.toThrow("run `spawnfile auth login agy --profile training`");
});

it("gives every boot its own evidence directory: the trial's own when the caller names one, a fresh one per judge boot", async () => {
  const { boots, run } = harness();
  const judge = await run.judge({ engine: "agy", model: "default" });
  await judge.wake("first", { deliveryId: "d1", timeoutMs: 1_000 });
  const trial = await run.boot({ trialId: "trial", instructions: "i", evidenceDirectory: "/trial-root/evidence" });
  await trial.teardown();
  await judge.wake("second", { deliveryId: "d2", timeoutMs: 1_000 });
  await run.close();
  const directories = boots.map((boot) => boot.evidenceDirectory);
  expect(directories[1]).toBe("/trial-root/evidence");
  expect(directories[0]).toContain(path.join("evidence", "judge-"));
  expect(directories[2]).toContain(path.join("evidence", "judge-"));
  expect(directories[2]).not.toBe(directories[0]);
});

it("passes the runtime's last failure at teardown through to the trial's caller", async () => {
  const { run } = harness();
  const trial = await run.boot({ trialId: "trial", instructions: "i" });
  expect(await trial.teardown()).toBe("last failure of trial");
  await run.close();
});
