import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hermesAuthDirectory, hermesAuthRouteFile } from "./auth.js";
import { hermesAuthLaunchCommand, hermesAuthLaunchScript } from "./authLaunch.js";

const badStore = "Hermes Agent needs a valid private native credential store for its selected subscription.\n";
const flockAvailable = spawnSync("flock", ["--version"]).status === 0;

describe("Hermes Agent authentication launch", () => {
  it("requires the compiled route decision and tolerates a declared API key route", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "hermes-auth-launch-"));
    const env = { ...process.env, HERMES_HOME: home };
    const run = () => spawnSync(process.execPath, ["-e", hermesAuthLaunchScript], { env, encoding: "utf8" });
    try {
      expect(run().stderr).toBe(badStore);
      await writeFile(path.join(home, hermesAuthRouteFile), "-\n", { mode: 0o600 });
      expect(run().status).toBe(0);
      await writeFile(path.join(home, hermesAuthRouteFile), "");
      expect(run().stderr).toBe(badStore);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  it.skipIf(!flockAvailable).each([
    ["openai-codex", "chatgpt", "xai-oauth"], ["xai-oauth", "oauth_device_code", "openai-codex"]
  ])("normalizes a pool-only %s grant once and rejects a foreign route", async (route, mode, foreignRoute) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "hermes-auth-lock-"));
    const env = { ...process.env, HERMES_HOME: home };
    const directory = path.join(home, hermesAuthDirectory);
    const storePath = path.join(directory, "auth.json");
    const routeFile = path.join(home, hermesAuthRouteFile);
    const run = () => spawnSync(hermesAuthLaunchCommand[0]!, [...hermesAuthLaunchCommand.slice(1), "printf", "started"], { env, encoding: "utf8" });
    const tokens = { access_token: "fixture-access", refresh_token: "fixture-refresh" };
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(routeFile, route, { mode: 0o600 });
      for (const file of ["auth.json", "auth.lock"]) await symlink(`${hermesAuthDirectory}/${file}`, path.join(home, file));
      await writeFile(storePath, JSON.stringify({ version: 1, credential_pool: { [route]: [
        { id: "e235f0", auth_type: "oauth", source: "manual:device_code", ...tokens }
      ] } }), { mode: 0o600 });
      expect(run()).toMatchObject({ status: 0, stdout: "started", stderr: "" });
      const saved = await readFile(storePath, "utf8");
      expect(JSON.parse(saved)).toEqual({ version: 1, providers: { [route]: { auth_mode: mode, tokens } }, credential_pool: { [route]: [] } });
      expect(run().status).toBe(0);
      expect(await readFile(storePath, "utf8")).toBe(saved);
      await writeFile(routeFile, foreignRoute);
      expect(run()).toMatchObject({ status: 1, stdout: "", stderr: badStore });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
