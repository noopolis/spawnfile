import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedAuthProfile } from "../../auth/index.js";
import type { RuntimeAuthPreparationInput } from "../types.js";
import { opencodeAuthVolumesEnv, opencodeHost, opencodeLoginDirectory, prepareOpenCodeRuntimeAuth } from "./auth.js";
import { renderOpenCodeLaunch } from "./launchScript.js";

const profile = {
  authHome: "/test-auth", env: {}, imports: {}, name: "synthetic", profileDirectory: "/test-auth/profile",
  profilePath: "/test-auth/profile/profile.json", version: 1,
  nativeLogins: { "opencode/openai/agent-pilot": "pilot-login", "opencode/openai/*": "fallback-login" }
} satisfies ResolvedAuthProfile;
const containerHome = "/var/lib/spawnfile/instances/opencode/agent-pilot/home";
const input = {
  authProfile: profile,
  env: {},
  instance: {
    config_path: "/var/lib/spawnfile/instances/opencode/agent-pilot/opencode.json", home_path: containerHome, id: "agent-pilot",
    model_auth_methods: { openai: "codex" }, model_secrets_required: [], runtime: "opencode"
  },
  outputDirectory: "/not-used", tempRoot: "/not-used"
} satisfies RuntimeAuthPreparationInput;

const source = "synthetic-oauth-login";
const auth = { type: "oauth", refresh: source, access: "", expires: 0, accountId: "synthetic-account" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function harness(provider: "openai" | "xai" | "github-copilot" = "openai") {
  const home = await mkdtemp(join(tmpdir(), "spawnfile-opencode-auth-test-"));
  roots.push(home);
  const login = join(home, opencodeLoginDirectory);
  const file = join(login, "auth.json");
  const compiled = join(home, "compiled-wrapper.sh");
  const native = join(home, "native");
  const data = join(home, "data");
  const config = join(home, "opencode.json");
  await mkdir(login, { mode: 0o700 });
  const model = { openai: "gpt-5.5", xai: "grok-4.6", "github-copilot": "gpt-5" }[provider];
  const keyName = { openai: "OPENAI_API_KEY", xai: "XAI_API_KEY", "github-copilot": "GITHUB_TOKEN" }[provider];
  const method = { openai: "codex", xai: "grok", "github-copilot": "subscription" } as const;
  await writeFile(file, JSON.stringify({ [provider]: { ...auth, ...(provider !== "openai" ? { access: "synthetic-access" } : {}) } }), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ model: `${provider}/${model}`, agent: { build: { variant: "high" } } }));
  await writeFile(compiled, renderOpenCodeLaunch({ provider, name: model, auth: { method: method[provider] } }));
  await writeFile(native, `#!/bin/bash
set -eu
test -z "\${OPENCODE_AUTH_CONTENT:-}\${${keyName}:-}"
case "$1" in
  models) test -z "$OPENCODE_CONFIG"
    test "$OPENCODE_CONFIG_CONTENT" = '{"enabled_providers":["${provider}"]}'
    printf '%s\\n' '${provider}/other' '{}' '${provider}/${model}' '{"capabilities":{"toolcall":true},"variants":{"high":{"reasoningEffort":"high"}}}' ;;
  run) printf '%s' '{"openai":{"type":"oauth","refresh":"synthetic-rotated","access":"synthetic-access","expires":42,"accountId":"synthetic-account"}}' > "$XDG_DATA_HOME/opencode/auth.json"
    test -z "\${OPENCODE_CONFIG_CONTENT:-}"
    cat ;;
  serve) printf '%s\\n' ready
    read -r unused || true ;;
  *) test -r "$XDG_DATA_HOME/opencode/auth.json" ;;
esac
`, { mode: 0o700 });
  const env = {
    HOME: home, PATH: dirname(process.execPath) + ":/usr/bin:/bin",
    OPENCODE_AUTH_CONTENT: "synthetic-env-ignored", [keyName]: "synthetic-key-ignored",
    OPENCODE_CONFIG_CONTENT: "synthetic-config-ignored", OPENCODE_CONFIG: config
  };
  return {
    login, file, compiled, config, data,
    start: () => spawn("/bin/bash", [compiled, native, "serve"], { env: { ...env, XDG_DATA_HOME: data }, timeout: 4_000 }),
    run: (command: string, xdg = data) => spawnSync("/bin/bash", [compiled, native, command], {
      env: { ...env, XDG_DATA_HOME: xdg },
      encoding: "utf8", input: "--preserve prompt\n  whitespace", timeout: 10_000
    })
  };
}

describe("OpenCode native subscription projection", () => {
  it("projects only the declared instance's writable named volume for project and image launches", async () => {
    const args = ["--mount", `type=volume,source=pilot-login,target=${containerHome}/.spawnfile-opencode-login,volume-nocopy`];
    expect(await prepareOpenCodeRuntimeAuth(input)).toEqual({ mountArgs: args, coveredModelSecrets: [] });
    expect(await opencodeHost.prepareImageAuth!({
      ...input.instance, node_ids: [], internal_port: 4096, published_port: null, workspace_path: "/instances/pilot/workspace"
    }, { authProfile: profile, tempRoot: input.tempRoot, sourceEnvironment: input.env })).toEqual(args);
    await expect(prepareOpenCodeRuntimeAuth({ ...input, authProfile: null })).rejects.toThrow(/requires a selected Spawnfile auth profile/);
    await expect(prepareOpenCodeRuntimeAuth({
      ...input, instance: { ...input.instance, home_path: "/another-agent/home" }
    })).rejects.toThrow(/canonical instance home/);
    expect(await prepareOpenCodeRuntimeAuth({
      ...input, instance: { ...input.instance, model_auth_methods: { openai: "api_key" } }
    })).toEqual({ mountArgs: [], coveredModelSecrets: [] });
  });

  it.each([["xai", "grok"], ["github-copilot", "subscription"]] as const)(
    "uses a scoped native %s OAuth entry", async (provider, method) => {
      const instance = { ...input.instance, model_auth_methods: { [provider]: method } };
      const nativeProfile = { ...profile, nativeLogins: { [`opencode/${provider}/agent-pilot`]: "pilot-login" } };
      expect(await prepareOpenCodeRuntimeAuth({ ...input, instance, authProfile: nativeProfile })).toEqual(await prepareOpenCodeRuntimeAuth(input));
      const trial = await harness(provider);
      expect(trial.run("spawnfile-serve").status).toBe(0);
      await writeFile(trial.file, JSON.stringify({ openai: auth }));
      const result = trial.run("acp");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`needs a usable native ${provider} OAuth login`);
    }
  );

  it.each([
    ["{}", /needs a native login volume/],
    ["synthetic-oauth-login", /must be a JSON object/],
    ['{"agent-pilot":"pilot-login,readonly"}', /needs a native login volume/],
    ['{"agent-pilot":"pilot-login","agent-other":"pilot-login"}', /only one runtime instance/]
  ])("rejects missing or unsafe bindings without leaking values", async (value, diagnostic) => {
    const authProfile = { ...profile, env: { [opencodeAuthVolumesEnv]: value }, nativeLogins: {} };
    await expect(prepareOpenCodeRuntimeAuth({ ...input, authProfile })).rejects.toThrow(diagnostic);
    await expect(prepareOpenCodeRuntimeAuth({ ...input, authProfile })).rejects.not.toThrow(source);
  });

  it("uses a single durable auth file across restarts and a separate training data home", async () => {
    const trial = await harness();
    expect(await readFile(trial.compiled, "utf8")).not.toContain(source);
    expect(trial.run("spawnfile-serve").status).toBe(0);
    expect(trial.run("acp").status).toBe(0);
    const training = join(trial.data, "training", "trial");
    const result = trial.run("run", training);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0, stdout: "--preserve prompt\n  whitespace", stderr: ""
    });
    expect(await readlink(join(trial.data, "opencode", "auth.json"))).toBe(trial.file);
    expect(await readlink(join(training, "opencode", "auth.json"))).toBe(trial.file);
    expect(JSON.parse(await readFile(trial.file, "utf8")).openai.refresh).toBe("synthetic-rotated");
    expect(trial.run("spawnfile-serve").status).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("reserves a login until the serving process exits", async () => {
    const trial = await harness();
    const server = trial.start();
    const exited = once(server, "exit");
    try {
      const first = await Promise.race([once(server.stdout, "data"), exited]);
      expect(String(first[0])).toBe("ready\n");
      expect(trial.run("serve").status).toBe(73);
    } finally {
      server.stdin.end();
      await exited;
    }
    expect(trial.run("serve").status).toBe(0);
  });

  it.each(["missing", "malformed", "api", "no refresh", "private file mode", "private directory mode", "symlink"])(
    "refuses a %s login without exposing credential bytes", async issue => {
      const trial = await harness();
      if (issue === "missing") await rm(trial.file);
      if (issue === "malformed") await writeFile(trial.file, source);
      if (issue === "api") await writeFile(trial.file, JSON.stringify({ openai: { type: "api", key: source } }));
      if (issue === "no refresh") await writeFile(trial.file, JSON.stringify({ openai: { ...auth, refresh: "" } }));
      if (issue === "private file mode") await chmod(trial.file, 0o644);
      if (issue === "private directory mode") await chmod(trial.login, 0o755);
      if (issue === "symlink") {
        await rm(trial.file);
        await symlink(trial.config, trial.file);
      }
      const result = trial.run("acp");
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/needs a usable native openai OAuth login/);
      expect(result.stderr + result.stdout).not.toContain(source);
    }
  );

  it.each([
    { model: "openai/gpt-5.3" },
    { model: "openai/gpt-5.5", agent: { build: { variant: "ultra" } } }
  ])("rejects unlisted models and variants instead of letting the native CLI fall back", async mismatch => {
    const trial = await harness();
    await writeFile(trial.config, JSON.stringify(mismatch));
    const result = trial.run("spawnfile-serve");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pinned openai catalog/);
  });
});
