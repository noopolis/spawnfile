import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedAuthProfile } from "../../auth/index.js";
import type { RuntimeAuthPreparationInput } from "../types.js";
import { prepareHermesRuntimeAuth } from "./auth.js";

let directory: string;
let profile: ResolvedAuthProfile;
let input: RuntimeAuthPreparationInput;
const home = "/var/lib/spawnfile/instances/hermes-agent/agent-test/hermes";

const codex = { tokens: { access_token: "synthetic-codex-access", refresh_token: "synthetic-codex-refresh" } };
const grok = { version: 1, providers: {
  "xai-oauth": {
    auth_mode: "oauth_device_code",
    tokens: { access_token: "synthetic-xai-access", refresh_token: "synthetic-xai-refresh" }
  },
  other: { tokens: { access_token: "unrelated-synthetic" } }
} };

function authFile(kind: "codex" | "grok") {
  return path.join(profile.imports[kind]!.path, "auth.json");
}

function sourceDirectory(args: string[]): string {
  expect(args).toEqual(["--mount", expect.stringMatching(new RegExp(`,dst=${home}/\\.spawnfile-auth$`, "u"))]);
  return args[1]!.split(",")[1]!.slice(4);
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "hermes-auth-test-"));
  profile = { authHome: directory, env: {}, imports: {}, name: "fixture", profileDirectory: directory,
    profilePath: path.join(directory, "profile.json"), version: 1 };
  for (const kind of ["codex", "grok"] as const) {
    const source = path.join(directory, kind);
    await mkdir(source, { mode: 0o700 });
    profile.imports[kind] = { kind, path: source };
    await writeFile(authFile(kind), JSON.stringify(kind === "codex" ? codex : grok), { mode: 0o600 });
  }
  input = {
    authProfile: profile, env: {}, outputDirectory: "/must-not-write", tempRoot: "/unused",
    instance: { id: "agent-test", runtime: "hermes-agent", config_path: `${home}/config.yaml`,
      home_path: home, model_auth_methods: { openai: "codex" }, model_secrets_required: [] }
  };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Hermes Agent subscription preparation", () => {
  it("stages only Codex in a private writable store and keeps a concurrent refresh", async () => {
    const [first, second] = await Promise.all([prepareHermesRuntimeAuth(input), prepareHermesRuntimeAuth(input)]);
    expect(first).toEqual(second);
    expect(first.coveredModelSecrets).toEqual(["SPAWNFILE_CLI_AUTH_JSON"]);
    expect(JSON.stringify(first)).not.toContain("synthetic-codex");
    const source = sourceDirectory(first.mountArgs);
    const state = path.join(source, "auth.json");
    expect((await stat(source)).mode & 0o777).toBe(0o700);
    expect((await stat(state)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(state, "utf8"))).toEqual({
      version: 1, providers: { "openai-codex": { auth_mode: "chatgpt", tokens: codex.tokens } }
    });
    await writeFile(state, "{}");
    await expect(prepareHermesRuntimeAuth(input)).resolves.toEqual(first);
    expect(await readFile(state, "utf8")).toBe("{}");
    expect(JSON.parse(await readFile(authFile("codex"), "utf8"))).toEqual(codex);
  });

  it("stages exactly one native Hermes device-code xAI grant", async () => {
    input.instance.model_auth_methods = { xai: "grok" };
    const prepared = await prepareHermesRuntimeAuth(input);
    expect(prepared.coveredModelSecrets).toEqual([]);
    const source = sourceDirectory(prepared.mountArgs);
    expect(JSON.parse(await readFile(path.join(source, "auth.json"), "utf8"))).toEqual({
      version: 1, providers: { "xai-oauth": grok.providers["xai-oauth"] }
    });
    expect(JSON.stringify(prepared)).not.toContain("synthetic-xai");
  });

  it("rejects a Grok CLI grant and does not disclose malformed credentials", async () => {
    input.instance.model_auth_methods = { xai: "grok" };
    await writeFile(authFile("grok"), JSON.stringify({ tokens: grok.providers["xai-oauth"].tokens }));
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/Hermes xai-oauth device-code login/);
    await writeFile(authFile("grok"), "synthetic-malformed-secret");
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/^Hermes Agent requires a usable private Hermes xai-oauth device-code login in the selected auth profile$/);
  });

  it("rejects missing profiles, API-only Codex imports, wrong providers and unsafe auth paths", async () => {
    await expect(prepareHermesRuntimeAuth({ ...input, authProfile: null })).rejects.toThrow(/codex import/);
    await writeFile(authFile("codex"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-api-key" }));
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/Codex ChatGPT login/);
    input.instance.model_auth_methods = { xai: "codex" };
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/subscription provider/);
    input.instance.model_auth_methods = { openai: "codex" };
    input.instance.home_path = "/bad/../location";
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/private native home/);
  });

  it("does not read unrequested imports and requires private, regular credential files", async () => {
    const filename = authFile("codex");
    await chmod(filename, 0o644);
    input.instance.model_auth_methods = { openai: "api_key" };
    await expect(prepareHermesRuntimeAuth(input)).resolves.toEqual({ coveredModelSecrets: [], mountArgs: [] });
    input.instance.model_auth_methods = { openai: "codex" };
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/private Codex ChatGPT login/);
    await rm(filename);
    await symlink(authFile("grok"), filename);
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/private Codex ChatGPT login/);
  });
});
