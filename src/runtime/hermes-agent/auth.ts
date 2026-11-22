import path from "node:path";

import { nativeLoginVolume } from "../nativeLogin.js";
import { SpawnfileError } from "../../shared/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";
import { portalRoutes } from "./login.js";

export const hermesAuthDirectory = ".spawnfile-auth";
export const hermesAuthRouteFile = ".spawnfile-auth-route";
export const hermesSubscriptions = {
  codex: { provider: "openai", native: "openai-codex" },
  grok: { provider: "xai", native: "xai-oauth" }
} as const;

export function hermesAuthRoute(provider: string, method: string): string | undefined {
  if (method === "subscription") return portalRoutes.get(provider)?.native;
  if (method === "grok" || method === "codex") {
    const route = hermesSubscriptions[method];
    return route.provider === provider ? route.native : undefined;
  }
  return undefined;
}

export async function prepareHermesRuntimeAuth(input: RuntimeAuthPreparationInput): Promise<RuntimeAuthPreparationResult> {
  const { instance, authProfile } = input;
  const subscriptions = Object.entries(instance.model_auth_methods)
    .filter(([, method]) => ["codex", "grok", "subscription", "claude-code"].includes(method));
  if (!subscriptions.length) return { coveredModelSecrets: [], mountArgs: [] };
  if (subscriptions.length !== 1 || !hermesAuthRoute(...subscriptions[0]!)) {
    throw new SpawnfileError("validation_error", "Hermes Agent needs one supported native subscription provider per instance");
  }
  const [provider] = subscriptions[0]!;
  const home = instance.home_path;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(instance.id) ||
      home !== `/var/lib/spawnfile/instances/hermes-agent/${instance.id}/hermes` ||
      instance.config_path !== path.posix.join(home, "config.yaml")) {
    throw new SpawnfileError("validation_error", "Hermes Agent subscription auth needs one provider and a private native home");
  }
  const volume = nativeLoginVolume(authProfile, "hermes-agent", provider, instance.id);
  if (!volume) {
    const login = { openai: "chatgpt", xai: "supergrok" }[provider] ?? provider;
    throw new SpawnfileError("validation_error", `Use spawnfile auth login ${login} --runtime hermes-agent with the selected profile`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u.test(volume)) throw new SpawnfileError("validation_error", "Invalid native Hermes login volume");
  return { coveredModelSecrets: [], mountArgs: ["--mount", `type=volume,source=${volume},target=${path.posix.join(home, hermesAuthDirectory)},volume-nocopy`] };
}
