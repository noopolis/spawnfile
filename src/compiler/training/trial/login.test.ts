import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { loadAuthProfile, type ResolvedAuthProfile } from "../../../auth/index.js";
import type { PreparedTrial } from "./boot.js";
import { loginSubscriptionRealm } from "./login.js";

let home: string;
const previousHome = process.env.SPAWNFILE_HOME;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-login-home-")); process.env.SPAWNFILE_HOME = home; });
afterEach(async () => {
  if (previousHome === undefined) delete process.env.SPAWNFILE_HOME; else process.env.SPAWNFILE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const harness = () => {
  const docker: string[][] = [];
  const logins: Array<{ realms: ResolvedAuthProfile; dryRun?: boolean }> = [];
  let disposed = 0;
  const prepare = async (): Promise<PreparedTrial> => ({
    agentId: "judge-agy", engines: ["agy"], image: "login-image", runtimeRoot: "/opt/runtime",
    boot: async () => { throw new Error("not booted"); },
    dispose: async () => { disposed++; },
    login: async (realms, options = {}) => { logins.push({ realms, ...options }); return ["docker", "run", "-it", "login-image"]; }
  });
  return {
    docker, logins, disposed: () => disposed,
    options: { docker: async (args: readonly string[]) => { docker.push([...args]); return ""; }, prepare: prepare as never, scratchRoot: home }
  };
};

it("creates the profile's AGY volumes, runs the login on them alone and records it", async () => {
  const { docker, logins, disposed, options } = harness();
  const result = await loginSubscriptionRealm({ engine: "agy", profileName: "training", ...options });
  const binding = { realmVolume: "spawnfile-training-training-agy-realm", unlockVolume: "spawnfile-training-training-agy-unlock" };
  expect(result.binding).toEqual(binding);
  expect(docker.slice(0, 2)).toEqual([
    ["volume", "create", "--label", "spawnfile.subscription-realm=agy", binding.realmVolume],
    ["volume", "create", "--label", "spawnfile.subscription-realm=agy", binding.unlockVolume]
  ]);
  const unlock = docker[2]!;
  expect(unlock.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
  expect(unlock).toContain(`type=volume,source=${binding.unlockVolume},target=/unlock`);
  expect(unlock.slice(-2)).toEqual(["2000", "unlock"]);
  expect(logins).toEqual([{ realms: expect.objectContaining({ env: {}, imports: {}, realms: { agy: binding } }), dryRun: false }]);
  expect((await loadAuthProfile("training"))?.realms).toEqual({ agy: binding });
  expect(disposed()).toBe(1);
  // A second login re-enrolls the same volumes.
  await loginSubscriptionRealm({ engine: "agy", profileName: "training", ...options });
  expect(docker[3]).toEqual(docker[0]);
});

it("prepares and prints the login on a dry run without recording it", async () => {
  const { logins, options } = harness();
  const result = await loginSubscriptionRealm({ engine: "agy", profileName: "training", dryRun: true, ...options });
  expect(result.command).toEqual(["docker", "run", "-it", "login-image"]);
  expect(logins[0]?.dryRun).toBe(true);
  expect((await loadAuthProfile("training"))?.realms).toBeUndefined();
});

it("refuses an engine whose login is an importable file", async () => {
  const { options } = harness();
  await expect(loginSubscriptionRealm({ engine: "codex", profileName: "training", ...options })).rejects.toThrow("spawnfile auth import codex");
});
