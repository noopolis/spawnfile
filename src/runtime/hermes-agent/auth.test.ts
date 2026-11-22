import { describe, expect, it } from "vitest";

import type { ResolvedAuthProfile } from "../../auth/index.js";
import type { RuntimeAuthPreparationInput } from "../types.js";
import { prepareHermesRuntimeAuth } from "./auth.js";

const home = "/var/lib/spawnfile/instances/hermes-agent/agent-test/hermes";
const profile: ResolvedAuthProfile = {
  authHome: "/unused", env: {}, imports: { codex: { kind: "codex", path: "/must-not-read" },
    grok: { kind: "grok", path: "/must-not-read" } }, name: "fixture", profileDirectory: "/unused",
  profilePath: "/unused/profile.json", version: 1
};

function fixture(model_auth_methods: RuntimeAuthPreparationInput["instance"]["model_auth_methods"]): RuntimeAuthPreparationInput {
  return {
    authProfile: { ...profile }, env: {}, outputDirectory: "/must-not-write", tempRoot: "/unused",
    instance: { id: "agent-test", runtime: "hermes-agent", config_path: `${home}/config.yaml`,
      home_path: home, model_auth_methods, model_secrets_required: [] }
  };
}

describe("Hermes Agent subscription preparation", () => {
  it.each([
    ["openai", "codex", "chatgpt"], ["xai", "grok", "supergrok"], ["nous", "subscription", "nous"],
    ["minimax", "subscription", "minimax"]
  ] as const)("requires a native login for %s and mounts the selected volume intact", async (provider, method, login) => {
    const input = fixture({ [provider]: method });
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(`spawnfile auth login ${login} --runtime hermes-agent`);
    input.authProfile!.nativeLogins = { [`hermes-agent/${provider}/*`]: "generic", [`hermes-agent/${provider}/agent-test`]: "exact" };
    await expect(prepareHermesRuntimeAuth(input)).resolves.toEqual({ coveredModelSecrets: [],
      mountArgs: ["--mount", `type=volume,source=exact,target=${home}/.spawnfile-auth,volume-nocopy`] });
  });

  it("does not open a desktop login for an API key route", async () => {
    await expect(prepareHermesRuntimeAuth(fixture({ openai: "api_key" }))).resolves.toEqual({ coveredModelSecrets: [], mountArgs: [] });
  });

  it("refuses unsupported subscriptions, multiple routes, invalid volumes and unsafe home paths", async () => {
    await expect(prepareHermesRuntimeAuth(fixture({ xai: "codex" }))).rejects.toThrow(/one supported native subscription/);
    await expect(prepareHermesRuntimeAuth(fixture({ openai: "codex", xai: "grok" }))).rejects.toThrow(/one supported native subscription/);
    const input = fixture({ openai: "codex" });
    input.authProfile!.nativeLogins = { "hermes-agent/openai/*": "invalid,target=other" };
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/Invalid native Hermes login volume/);
    input.instance.home_path = "/bad/../location";
    await expect(prepareHermesRuntimeAuth(input)).rejects.toThrow(/private native home/);
  });
});
