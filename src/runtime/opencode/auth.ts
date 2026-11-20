import { posix } from "node:path";

import type { ResolvedAuthProfile } from "../../auth/index.js";
import type { EffectiveModelTarget } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import type { RuntimeHostIntegration } from "../hostTypes.js";
import { nativeLoginVolume } from "../nativeLogin.js";
import type { RuntimeAuthInstance, RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

export const opencodeLoginDirectory = ".spawnfile-opencode-login";
export const opencodeAuthVolumesEnv = "SPAWNFILE_OPENCODE_AUTH_VOLUMES";
export const opencodeSubscriptionMethods = { openai: "codex", xai: "grok", "github-copilot": "subscription" } as const;

type SubscriptionProvider = keyof typeof opencodeSubscriptionMethods;

function isSubscriptionProvider(provider: string): provider is SubscriptionProvider {
  return Object.hasOwn(opencodeSubscriptionMethods, provider);
}

export function openCodeSubscriptionProvider(target: EffectiveModelTarget | undefined): SubscriptionProvider | undefined {
  if (target && !target.endpoint && isSubscriptionProvider(target.provider) &&
    target.auth.method === opencodeSubscriptionMethods[target.provider]) return target.provider;
}

function loginMount(instance: RuntimeAuthInstance, profile: ResolvedAuthProfile | null): string[] {
  const methods = Object.entries(instance.model_auth_methods);
  const native = methods.filter(([, method]) => Object.values(opencodeSubscriptionMethods).some(entry => entry === method));
  const route = Object.entries(opencodeSubscriptionMethods).find(([provider, method]) => instance.model_auth_methods[provider] === method);
  if (native.length > 1 || (native.length && !route) || methods.some(([, method]) => method === "claude-code")) {
    throw new SpawnfileError("validation_error", "OpenCode requires one supported subscription provider per instance");
  }
  if (!route) {
    return [];
  }
  const home = instance.home_path;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/u.test(instance.id) ||
    home !== `/var/lib/spawnfile/instances/opencode/${instance.id}/home`) {
    throw new SpawnfileError("validation_error", "OpenCode subscription login requires a canonical instance home");
  }
  if (!profile) {
    throw new SpawnfileError("validation_error", "OpenCode subscription login requires a selected Spawnfile auth profile");
  }

  let entries: unknown;
  try {
    entries = JSON.parse(profile.env[opencodeAuthVolumesEnv] ?? "{}");
  } catch {
    throw new SpawnfileError("validation_error", `${opencodeAuthVolumesEnv} must be a JSON object of instance ids and volume names`);
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new SpawnfileError("validation_error", `${opencodeAuthVolumesEnv} must be a JSON object of instance ids and volume names`);
  }
  const volumes = new Map(Object.entries(entries));
  const name = volumes.get(instance.id) ?? nativeLoginVolume(profile, "opencode", route[0], instance.id);
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u.test(name)) {
    throw new SpawnfileError("validation_error", `OpenCode needs a native login volume for ${instance.id} from spawnfile auth login --runtime opencode or ${opencodeAuthVolumesEnv}`);
  }
  if ([...volumes.values()].filter(volume => volume === name).length > 1) {
    throw new SpawnfileError("validation_error", "OpenCode login volumes must be assigned to only one runtime instance");
  }
  return ["--mount", `type=volume,source=${name},target=${posix.join(home, opencodeLoginDirectory)},volume-nocopy`];
}

export async function prepareOpenCodeRuntimeAuth(input: RuntimeAuthPreparationInput): Promise<RuntimeAuthPreparationResult> {
  return {
    mountArgs: loginMount(input.instance, input.authProfile),
    coveredModelSecrets: []
  };
}

export const opencodeHost: RuntimeHostIntegration = {
  async prepareImageAuth(instance, input) {
    return loginMount(instance, input.authProfile);
  }
};
