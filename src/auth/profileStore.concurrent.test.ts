import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { registerNativeLogin, requireAuthProfile, setAuthProfileEnv } from "./profileStore.js";

const profileName = "synthetic";
const provider = "opencode/openai";
const store = new URL("./profileStore.ts", import.meta.url).href;
const roots: string[] = [];

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "spawnfile-profile-concurrency-"));
  roots.push(home);
  vi.stubEnv("SPAWNFILE_HOME", home);
  return home;
}

function worker(home: string, setup: string, edit: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { once } from "node:events";
    import { open } from "node:fs/promises";
    import * as profiles from ${JSON.stringify(store)};
    const name = ${JSON.stringify(profileName)};
    ${setup}
    const start = once(process, "message");
    process.send("ready");
    await start;
    ${edit}
    process.disconnect();
  `], {
    env: { PATH: process.env.PATH, HOME: home, SPAWNFILE_HOME: home },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    timeout: 15_000
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", text => { stderr += text; });
  const exited = once(child, "close");
  return {
    ready: Promise.race([
      once(child, "message").then(([message]) => expect(message).toBe("ready")),
      exited.then(() => { throw new Error(`Profile worker exited before setup:\n${stderr}`); })
    ]),
    start: () => child.send("start"),
    finish: async () => {
      const [code] = await exited;
      expect(code, stderr).toBe(0);
    },
    stop: async () => {
      child.kill();
      await exited;
    }
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each([true, false])("merges separate process updates and retains all bindings (existing profile: %s)", async existing => {
  const home = await fixture();
  const defaultLogin = `await profiles.registerNativeLogin(name, "${provider}/*", "synthetic-default");`;
  if (existing) await registerNativeLogin(profileName, `${provider}/*`, "synthetic-default");
  const edits = [
    `await profiles.registerNativeLogin(name, "${provider}/agent-one", "synthetic-one");`,
    `await profiles.registerNativeLogin(name, "${provider}/agent-two", "synthetic-two");`,
    'await profiles.setAuthProfileEnv(name, { FIXTURE: "synthetic-env" });',
    'await profiles.registerImportedAuth(name, "codex");',
    'await profiles.registerSubscriptionRealm(name, "agy", { realmVolume: "synthetic-realm", unlockVolume: "synthetic-unlock" });'
  ];
  if (!existing) edits.push(defaultLogin, "await profiles.ensureAuthProfile(name);");
  const workers = edits.map(edit => worker(home, "", edit));
  try {
    await Promise.all(workers.map(process => process.ready));
    for (const process of workers) process.start();
    await Promise.all(workers.map(process => process.finish()));
    const profile = await requireAuthProfile(profileName);
    expect(profile.nativeLogins).toEqual({
      [`${provider}/*`]: "synthetic-default",
      [`${provider}/agent-one`]: "synthetic-one",
      [`${provider}/agent-two`]: "synthetic-two"
    });
    expect(profile.env).toEqual({ FIXTURE: "synthetic-env" });
    expect(profile.imports).toEqual({
      codex: { kind: "codex", path: path.join(profile.profileDirectory, "imports", "codex") }
    });
    expect(profile.realms).toEqual({ agy: { realmVolume: "synthetic-realm", unlockVolume: "synthetic-unlock" } });
  } finally {
    await Promise.all(workers.map(process => process.stop()));
  }
});

it("publishes a whole new file while another process holds the previous profile open", async () => {
  const home = await fixture();
  const profile = await setAuthProfileEnv(profileName, { FIXTURE: "synthetic-before" });
  const reader = worker(home, `
    const previous = await profiles.requireAuthProfile(name);
    const handle = await open(previous.profilePath, "r");
  `, `
    try {
      assert.deepEqual(JSON.parse(await handle.readFile("utf8")).env, { FIXTURE: "synthetic-before" });
      const current = await profiles.requireAuthProfile(name);
      assert.deepEqual(current.env, { FIXTURE: "synthetic-after" });
    } finally {
      await handle.close();
    }
  `);
  try {
    await reader.ready;
    await setAuthProfileEnv(profileName, { FIXTURE: "synthetic-after" });
    reader.start();
    await reader.finish();
    expect((await stat(profile.profilePath)).mode & 0o777).toBe(0o600);
  } finally {
    await reader.stop();
  }
});
