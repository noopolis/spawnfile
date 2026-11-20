import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireAuthProfile, setAuthProfileEnv } from "../auth/profileStore.js";
import { nativeLoginVolume } from "./nativeLogin.js";
import { openCodeLogin } from "./opencode/login.js";
import { hermesLogin } from "./hermes-agent/login.js";

describe("native profile logins", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "sf-native-login-"));
    vi.stubEnv("SPAWNFILE_HOME", path.join(directory, "home"));
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "docker"), '#!/bin/sh\nif [ "$3" = "-it" ]; then exit "${FIXTURE_LOGIN_EXIT:-0}"; fi\n', { mode: 0o700 });
    vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it.each([
    [openCodeLogin, "chatgpt", "ChatGPT Pro/Plus (headless)"], [openCodeLogin, "copilot", "Login with GitHub Copilot"],
    [openCodeLogin, "supergrok", "SuperGrok Subscription"], [hermesLogin, "chatgpt", "openai-codex"],
    [hermesLogin, "supergrok", "xai-oauth"], [hermesLogin, "nous", "nous"]
  ] as const)("prepares the native device flow with no saved login on a dry run", async (login, engine, method) => {
    expect(login.supportsEngine(engine)).toBe(true);
    const result = await login.run({ engine, profileName: "sample", image: "local/login:fixture", dryRun: true });
    expect(result.command).toContain(method);
    expect((await requireAuthProfile("sample")).nativeLogins).toBeUndefined();
  });

  it("stores the volume name after success and keeps defaults separate from member overrides", async () => {
    const options = { engine: "chatgpt", profileName: "sample", image: "local/login:fixture" };
    const common = await openCodeLogin.run(options);
    const member = await openCodeLogin.run({ ...options, instance: "agent-bob" });
    const profile = await setAuthProfileEnv("sample", { A: "1" });
    if (!("nativeVolume" in common && "nativeVolume" in member)) throw Error("Expected native volumes");
    expect(common.nativeVolume).not.toEqual(member.nativeVolume);
    expect(nativeLoginVolume(profile, "opencode", "openai", "agent-ann")).toBe(common.nativeVolume);
    expect(nativeLoginVolume(profile, "opencode", "openai", "agent-bob")).toBe(member.nativeVolume);
    expect(nativeLoginVolume(profile, "hermes-agent", "openai", "agent-bob")).toBeUndefined();
    expect(JSON.parse(await readFile(profile.profilePath, "utf8")).nativeLogins).toEqual({
      "opencode/openai/*": common.nativeVolume, "opencode/openai/agent-bob": member.nativeVolume
    });
  });

  it("leaves the profile unbound when the native client fails", async () => {
    vi.stubEnv("FIXTURE_LOGIN_EXIT", "1");
    await expect(hermesLogin.run({ engine: "nous", profileName: "sample", image: "local/login:fixture" })).rejects.toThrow(/did not complete/);
    expect((await requireAuthProfile("sample")).nativeLogins).toBeUndefined();
  });
});
