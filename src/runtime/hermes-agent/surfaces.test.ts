import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentSurfaces } from "../../compiler/agentSurfaces.js";
import type { ResolvedAgentNode } from "../../compiler/types.js";
import { surfacesSchema } from "../../manifest/surfaceSchemas.js";
import { hermesAgentAdapter } from "./adapter.js";
import {
  assertSupportedHermesSurfaces,
  buildHermesSurfaceConfig,
  buildHermesSurfaceEnvCommand,
  buildHermesSurfaceEnvBindings
} from "./surfaces.js";

function resolve(input: unknown) {
  return resolveAgentSurfaces(surfacesSchema.parse(input));
}

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
const executablePath = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);

function surfaceCommand(names: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "hermes-surface-"));
  directories.push(directory);
  const report = join(directory, "report.json");
  writeFileSync(report, JSON.stringify({secrets: {surface: names.map(name => ({name}))}}));
  return buildHermesSurfaceEnvCommand(report);
}

describe("Hermes gateway surfaces", () => {
  it("starts no public adapters by default, including a declaration without access", () => {
    for (const surfaces of [undefined, resolve({ telegram: {}, discord: {}, slack: {} })]) {
      const config = buildHermesSurfaceConfig(surfaces);
      expect(config.multiplex_profiles).toBe(false);
      expect(config).not.toHaveProperty("GATEWAY_ALLOW_ALL_USERS");
      expect(Object.values(config.platforms as object).every(platform => platform.enabled === false)).toBe(true);
    }
  });

  it("uses both Telegram gates for users and chats without granting the entire chat", () => {
    const config = buildHermesSurfaceConfig(resolve({
      telegram: { access: { users: ["123"], chats: ["-10042"] }, identity: { username: "advertised_bot" } }
    }));
    expect(config).toMatchObject({
      TELEGRAM_ALLOWED_USERS: "123",
      platforms: { telegram: { enabled: true, extra: {
        allowed_chats: ["-10042"], guest_mode: false, require_mention: true, unauthorized_dm_behavior: "ignore"
      } } }
    });
    expect(config).not.toHaveProperty("platforms.telegram.extra.group_allowed_chats");
    expect(JSON.stringify(config)).not.toContain("advertised_bot");
  });

  it("limits Telegram chat grants to groups and explicit pairing to DMs", () => {
    const config = buildHermesSurfaceConfig(resolve({ telegram: { access: { chats: ["-10042"] } } }));
    expect(config).toHaveProperty("platforms.telegram.extra.group_allowed_chats", ["-10042"]);
    expect(config).not.toHaveProperty("TELEGRAM_ALLOWED_USERS");

    const pairing = buildHermesSurfaceConfig(resolve({ telegram: { access: { mode: "pairing" } } }));
    expect(pairing).toHaveProperty("platforms.telegram.extra.allowed_chats", ["0"]);
    expect(pairing).toHaveProperty("platforms.telegram.extra.unauthorized_dm_behavior", "pair");
    expect(pairing).not.toHaveProperty("TELEGRAM_ALLOW_ALL_USERS");
  });

  it("prevents group traffic for Discord and Slack user-only allowlists", () => {
    const config = buildHermesSurfaceConfig(resolve({
      discord: { access: { users: ["123"] } },
      slack: { access: { users: ["U123"] } }
    }));
    expect(config).toMatchObject({
      DISCORD_ALLOWED_USERS: "123",
      SLACK_ALLOWED_USERS: "U123",
      platforms: {
        discord: { extra: { ignored_channels: ["*"], require_mention: true, thread_require_mention: true } },
        slack: { extra: { allowed_channels: ["0"], require_mention: true, strict_mention: true } }
      }
    });
  });

  it("preserves Slack user and channel gates together", () => {
    const config = buildHermesSurfaceConfig(resolve({ slack: { access: { users: ["U1", "W2"], channels: ["C3", "G4"] } } }));
    expect(config.SLACK_ALLOWED_USERS).toBe("U1,W2");
    expect(config).toHaveProperty("platforms.slack.extra.allowed_channels", ["C3", "G4"]);
  });

  it("opens only the explicitly declared platform while retaining mention gates", () => {
    for (const platform of ["telegram", "discord", "slack"] as const) {
      const config = buildHermesSurfaceConfig(resolve({ [platform]: { access: { mode: "open" } } }));
      expect(Object.keys(config).filter(key => key.endsWith("_ALLOW_ALL_USERS"))).toEqual([
        `${platform.toUpperCase()}_ALLOW_ALL_USERS`
      ]);
      expect(config).toHaveProperty(`platforms.${platform}.extra.require_mention`, true);
      expect(config).not.toHaveProperty(`platforms.${platform}.extra.home_channel`);
    }
  });

  it.each([
    [{ discord: { access: { mode: "pairing" } } }, /Discord rejects unknown DMs/],
    [{ discord: { access: { users: ["123"], guilds: ["999"] } } }, /guild allowlist/],
    [{ discord: { access: { channels: ["999"] } } }, /match mutable names/],
    [{ slack: { access: { mode: "pairing" } } }, /Slack rejects unknown DM messages/],
    [{ slack: { access: { channels: ["C999"] } } }, /Slack requires a user allowlist/],
    [{ slack: { access: { users: ["U1"], channels: ["D2"] } } }, /Slack access.channels/],
    [{ telegram: { access: { chats: ["123"] } } }, /Telegram access.chats/],
    [{ telegram: { access: { users: ["123,*"] } } }, /Telegram access.users/],
    [{ discord: { access: { users: ["*"] } } }, /Discord access.users/],
    [{ slack: { access: { users: ["U1,*"] } } }, /Slack access.users/],
    [{ slack: { app_token_secret: "SAME", bot_token_secret: "SAME" } }, /separate bot and Socket Mode/],
    [{ telegram: { bot_token_secret: "bad-name" } }, /environment variable names/],
    [{ whatsapp: { access: { users: ["+15550102"] } } }, /Baileys session/]
  ])("fails closed for %j", (manifest, error) => {
    expect(() => assertSupportedHermesSurfaces(resolve(manifest))).toThrow(error);
    expect(() => buildHermesSurfaceConfig(resolve(manifest))).toThrow(error);
  });

  it("refuses legacy HTTP input", () => {
    expect(() => assertSupportedHermesSurfaces({
      http: { pathPrefix: "/api", auth: { mode: "bearer", tokenSecret: "HTTP_SECRET" } }
    })).toThrow(/HTTP ingress policy/);
  });

  it("refuses a resolved outbound webhook and signing policy", () => {
    expect(() => assertSupportedHermesSurfaces(resolve({
      webhook: { url: "https://example.test", signing_secret: "HOOK_SECRET" }
    }))).toThrow(/outbound webhook/);
  });

  it("binds only this member's token references into structured config paths", () => {
    const one = resolve({
      telegram: { bot_token_secret: "ONE_TELEGRAM" },
      slack: { bot_token_secret: "ONE_SLACK_BOT", app_token_secret: "ONE_SLACK_APP" }
    });
    const two = resolve({ discord: { bot_token_secret: "TWO_DISCORD" } });
    expect(buildHermesSurfaceEnvBindings(one)).toEqual([
      { envName: "ONE_TELEGRAM", jsonPath: ["platforms", "telegram", "token"] },
      { envName: "ONE_SLACK_BOT", jsonPath: ["platforms", "slack", "token"] },
      { envName: "ONE_SLACK_APP", jsonPath: ["SLACK_APP_TOKEN"] }
    ]);
    expect(buildHermesSurfaceEnvBindings(two)).toEqual([
      { envName: "TWO_DISCORD", jsonPath: ["platforms", "discord", "token"] }
    ]);
    expect(buildHermesSurfaceEnvBindings(undefined)).toEqual([]);
    expect(JSON.stringify(buildHermesSurfaceConfig(one))).not.toContain("ONE_");
  });

  it("strips ambient chat credentials, policy and recipients before launching", () => {
    const [file, ...args] = surfaceCommand();
    const result = spawnSync(file!, [...args, "/usr/bin/env"], { encoding: "utf8", env: {
      BASH_ENV: "",
      PATH: executablePath,
      HERMES_HOME: "/fake-home",
      TELEGRAM_BOT_TOKEN: "fake-sibling-telegram",
      DISCORD_BOT_TOKEN: "fake-sibling-discord",
      SLACK_APP_TOKEN: "fake-sibling-slack",
      WHATSAPP_ENABLED: "true",
      TELEGRAM_GROUP_ALLOWED_CHATS: "-42",
      GATEWAY_ALLOW_ALL_USERS: "true",
      HERMES_GATEWAY_MULTIPLEX: "true",
      HERMES_MANAGED_DIR: "/fake-managed-settings",
      HERMES_CONFIG_BACKEND: "external",
      SLACK_HOME_CHANNEL: "C123",
      API_SERVER_KEY: "fake-foreign-key",
      WEBHOOK_ENABLED: "true"
    } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("HERMES_HOME=/fake-home");
    expect(result.stdout).not.toMatch(/^(?:TELEGRAM|DISCORD|SLACK|WHATSAPP|GATEWAY|HERMES_GATEWAY|API_SERVER|WEBHOOK)_/mu);
    expect(result.stdout).not.toMatch(/^HERMES_(?:MANAGED_DIR|CONFIG_BACKEND)=/mu);
  });

  it("removes custom secret aliases passed by the parent launch plan", () => {
    const [file, ...args] = surfaceCommand(["SIBLING_TOKEN", "THIS_TOKEN"]);
    const result = spawnSync(file!, [...args, "/usr/bin/env"], { encoding: "utf8", env: {
      PATH: executablePath,
      SIBLING_TOKEN: "fake-sibling-token",
      THIS_TOKEN: "fake-this-token",
      KEEP_ME: "value"
    } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("KEEP_ME=value");
    expect(result.stdout).not.toMatch(/^(?:SIBLING_TOKEN|THIS_TOKEN)=/mu);
  });

  it("uses the member config and bindings through the runtime adapter", async () => {
    const value: ResolvedAgentNode = {
      name: "surface-test", description: "", kind: "agent", source: "/fake/Spawnfile",
      docs: [], env: {}, mcpServers: [], secrets: [], skills: [], subagents: [],
      policyMode: null, policyOnDegrade: null, runtime: { name: "hermes-agent", options: {} },
      execution: { model: { primary: {
        provider: "local", name: "offline", endpoint: { base_url: "http://127.0.0.1:8123/v1", compatibility: "openai" }
      } } },
      surfaces: resolve({ slack: {
        access: { users: ["U123"], channels: ["C123"] }, bot_token_secret: "MEMBER_BOT", app_token_secret: "MEMBER_APP"
      } })!
    };
    const compiled = await hermesAgentAdapter.compileAgent(value);
    const [target] = await hermesAgentAdapter.createContainerTargets!([
      { value, id: "member", kind: "agent", slug: "surface-test", emittedFiles: compiled.files }
    ]);
    const config = JSON.parse(compiled.files.find(file => file.path === "config.yaml")!.content);
    expect(config.platforms.slack).toMatchObject({ enabled: true, extra: { allowed_channels: ["C123"] } });
    expect(config.platform_toolsets.slack).toEqual(config.platform_toolsets.acp);
    expect(target?.configEnvBindings).toEqual(buildHermesSurfaceEnvBindings(value.surfaces));
    expect(hermesAgentAdapter.container.startCommand).toContain("hermes-surface-env");
  });
});
