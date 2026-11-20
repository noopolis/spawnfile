import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { nativeLoginVolume } from "../nativeLogin.js";
import { CLI_CREDENTIAL_SECRET_NAME } from "../../compiler/modelEnv.js";
import { SpawnfileError } from "../../shared/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

export const hermesAuthDirectory = ".spawnfile-auth";
export const hermesSubscriptions = {
  codex: { provider: "openai", native: "openai-codex", mode: "chatgpt" },
  grok: { provider: "xai", native: "xai-oauth", mode: "oauth_device_code" }
} as const;

type Subscription = keyof typeof hermesSubscriptions;
const subscriptions = Object.keys(hermesSubscriptions) as Subscription[];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function token(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && !/\s/u.test(value) ? value : undefined;
}

function privatePath(value: string): boolean {
  return path.isAbsolute(value) && !/[:,\u0000-\u001f\u007f]/u.test(value);
}

function assertPrivateFile(file: { isFile(): boolean; mode: number }): void {
  if (!file.isFile() || (file.mode & 0o777) !== 0o600) {
    throw new Error("expected a private regular file");
  }
}

async function readImport(directory: string): Promise<Record<string, unknown>> {
  if (!privatePath(directory)) throw new Error("invalid import directory");
  const handle = await open(path.join(directory, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assertPrivateFile(await handle.stat());
    return record(JSON.parse((await handle.readFile("utf8")).replace(/^\uFEFF/u, "")));
  } finally {
    await handle.close();
  }
}

function importState(kind: Subscription, source: Record<string, unknown>) {
  const { mode, native } = hermesSubscriptions[kind];
  const nativeState = record(record(source.providers)[native]);
  // Grok CLI grants use a different OAuth client. Accept only a native Hermes device-code login.
  const state = kind === "grok" || nativeState.auth_mode === mode ? nativeState : source;
  if (kind === "grok" ? source.version !== 1 || state.auth_mode !== mode :
    state.auth_mode !== undefined && state.auth_mode !== mode) {
    throw new Error("wrong login type");
  }
  const tokens = record(state.tokens);
  const access_token = token(tokens.access_token);
  const refresh_token = token(tokens.refresh_token);
  if (!access_token || !refresh_token) throw new Error("incomplete login");
  const account_id = kind === "codex" ? token(tokens.account_id) : undefined;
  const last_refresh = typeof state.last_refresh === "string" && Number.isFinite(Date.parse(state.last_refresh))
    ? state.last_refresh : undefined;
  return {
    auth_mode: mode,
    tokens: { access_token, refresh_token, ...(account_id ? { account_id } : {}) },
    ...(last_refresh ? { last_refresh } : {})
  };
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("expected a private directory");
  }
}

async function openRuntimeStore(profileDirectory: string, kind: Subscription, state: ReturnType<typeof importState>) {
  if (!privatePath(profileDirectory)) throw new Error("invalid profile directory");
  const runtimeDirectory = path.join(profileDirectory, "hermes-agent");
  const providerDirectory = path.join(runtimeDirectory, hermesSubscriptions[kind].native);
  // The original import identifies this grant across restarts. Updating its access token or
  // re-importing the same seed must not replace the native store's rotated refresh token.
  const grant = createHash("sha256").update(state.tokens.refresh_token).digest("hex");
  const directory = path.join(providerDirectory, grant);
  for (const entry of [runtimeDirectory, providerDirectory, directory]) await privateDirectory(entry);
  const target = path.join(directory, "auth.json");
  const current = await lstat(target).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!current) {
    const seed = path.join(providerDirectory, randomUUID());
    const native = hermesSubscriptions[kind].native;
    await writeFile(seed, JSON.stringify({ version: 1, providers: { [native]: state } }), { mode: 0o600, flag: "wx" });
    try {
      await link(seed, target).catch(error => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await unlink(seed);
    }
  }
  assertPrivateFile(await lstat(target));
  return directory;
}

export async function prepareHermesRuntimeAuth(input: RuntimeAuthPreparationInput): Promise<RuntimeAuthPreparationResult> {
  const { instance, authProfile } = input;
  const declared = Object.entries(instance.model_auth_methods);
  const required = subscriptions.filter(kind => declared.some(([, method]) => method === kind));
  if (required.some(kind => declared.some(([provider, method]) => method === kind && provider !== hermesSubscriptions[kind].provider)) ||
      declared.some(([, method]) => method === "claude-code")) {
    throw new SpawnfileError("validation_error", "Unsupported Hermes Agent subscription provider");
  }
  const native = declared.filter(([, method]) => method === "grok" || method === "codex" || method === "subscription");
  if (native.some(([provider, method]) => method === "subscription" && provider !== "nous") || native.length > 1)
    throw new SpawnfileError("validation_error", "Hermes Agent needs one native subscription provider per instance");
  const route = native[0];
  if (!route) return { coveredModelSecrets: [], mountArgs: [] };
  const [kind] = required;
  const home = instance.home_path;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(instance.id) ||
      home !== `/var/lib/spawnfile/instances/hermes-agent/${instance.id}/hermes` || !privatePath(home) ||
      path.posix.normalize(home) !== home || instance.config_path !== path.posix.join(home, "config.yaml")) {
    throw new SpawnfileError("validation_error", "Hermes Agent subscription auth needs one provider and a private native home");
  }
  const volume = nativeLoginVolume(authProfile, "hermes-agent", route[0], instance.id);
  if (volume) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u.test(volume)) throw new SpawnfileError("validation_error", "Invalid native Hermes login volume");
    return { coveredModelSecrets: [], mountArgs: ["--mount", `type=volume,source=${volume},target=${path.posix.join(home, hermesAuthDirectory)},volume-nocopy`] };
  }
  if (!kind) throw new SpawnfileError("validation_error", "Use spawnfile auth login nous --runtime hermes-agent with the selected profile");
  const imported = authProfile?.imports[kind];
  if (!authProfile || imported?.kind !== kind) {
    throw new SpawnfileError("validation_error", `Hermes Agent requires a Spawnfile auth profile with a ${kind} import`);
  }

  let source: string;
  try {
    const state = importState(kind, await readImport(imported.path));
    source = await openRuntimeStore(authProfile.profileDirectory, kind, state);
  } catch {
    const login = kind === "grok" ? "Hermes xai-oauth device-code login" : "Codex ChatGPT login";
    throw new SpawnfileError("validation_error", `Hermes Agent requires a usable private ${login} in the selected auth profile`);
  }
  return {
    coveredModelSecrets: kind === "codex" ? [CLI_CREDENTIAL_SECRET_NAME] : [],
    mountArgs: ["--mount", `type=bind,src=${source},dst=${path.posix.join(home, hermesAuthDirectory)}`]
  };
}
