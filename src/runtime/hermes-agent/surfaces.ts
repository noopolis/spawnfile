import type { ResolvedAgentSurfaces } from "../../compiler/types.js";
import { DISTRIBUTION_REPORT_IMAGE_PATH } from "../../distribution/types.js";
import { SpawnfileError } from "../../shared/index.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";

const chatPlatforms = ["telegram", "discord", "slack"] as const;
const disabledPlatforms = [
  "a2a", "api_server", "bluebubbles", "buzz", "dingtalk", "email", "feishu",
  "google_chat", "irc", "line", "matrix", "mattermost", "msgraph_webhook",
  "ntfy", "photon", "qqbot", "raft", "relay", "signal", "simplex", "sms",
  "teams", "webhook", "wecom", "wecom_callback", "weixin", "whatsapp",
  "whatsapp_cloud"
] as const;

// Telegram group IDs are negative and Slack channel IDs start with a letter.
const noGroupChannel = "0";
const positiveId = /^[1-9][0-9]*$/u;
const telegramGroupId = /^-[1-9][0-9]*$/u;
const slackUserId = /^[UW][A-Z0-9]+$/u;
const slackChannelId = /^[CG][A-Z0-9]+$/u;

function unsupported(reason: string): never {
  throw new SpawnfileError("validation_error", `Hermes Agent ${reason}`);
}

function assertIds(platform: string, field: string, ids: string[], pattern: RegExp): void {
  if (ids.some((id) => !pattern.test(id))) {
    unsupported(`${platform} access.${field} must use native IDs without wildcards or separators`);
  }
}

function assertSecretEnvName(name: string, surface = "surface"): void {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    unsupported(`${surface} secret references must be environment variable names`);
  }
}

export function assertSupportedHermesSurfaces(surfaces: ResolvedAgentSurfaces | undefined): void {
  if (surfaces?.http) unsupported("cannot map a portable HTTP ingress policy");
  if (surfaces?.webhook) unsupported("cannot map the portable outbound webhook and its signing policy to its inbound webhook listener");
  if (surfaces?.whatsapp) unsupported("WhatsApp requires a provisioned per-agent Baileys session and bridge dependencies in the pinned image, which Spawnfile does not supply");

  for (const platform of chatPlatforms) {
    const surface = surfaces?.[platform];
    if (surface) assertSecretEnvName(surface.botTokenSecret, `${platform} surface`);
  }
  if (surfaces?.slack) {
    assertSecretEnvName(surfaces.slack.appTokenSecret, "slack surface");
    if (surfaces.slack.appTokenSecret === surfaces.slack.botTokenSecret) {
      unsupported("Slack requires separate bot and Socket Mode app token references");
    }
  }

  const telegram = surfaces?.telegram?.access;
  if (telegram?.mode === "allowlist") {
    if (!telegram.users.length && !telegram.chats.length) unsupported("Telegram allowlist requires users or chats");
    assertIds("Telegram", "users", telegram.users, positiveId);
    assertIds("Telegram", "chats", telegram.chats, telegramGroupId);
  }

  const discord = surfaces?.discord?.access;
  if (discord?.mode === "pairing") {
    unsupported("Discord rejects unknown DMs before they can reach native pairing");
  }
  if (discord?.mode === "allowlist") {
    if (discord.guilds.length) unsupported("Discord cannot enforce a guild allowlist");
    if (discord.channels.length) unsupported("Discord channel gates match mutable names as well as IDs, so they cannot enforce a channel ID allowlist");
    if (!discord.users.length) unsupported("Discord allowlist requires users");
    assertIds("Discord", "users", discord.users, positiveId);
  }

  const slack = surfaces?.slack?.access;
  if (slack?.mode === "pairing") {
    unsupported("Slack rejects unknown DM messages before they can reach native pairing");
  }
  if (slack?.mode === "allowlist") {
    if (!slack.users.length) unsupported("Slack requires a user allowlist because its channel check does not authorize the sender at the gateway");
    assertIds("Slack", "users", slack.users, slackUserId);
    assertIds("Slack", "channels", slack.channels, slackChannelId);
  }
}

type ChatPlatform = typeof chatPlatforms[number];
type ChatAccess = NonNullable<NonNullable<ResolvedAgentSurfaces[ChatPlatform]>["access"]>;

function buildChatPolicy(access: ChatAccess | undefined): Record<string, unknown> {
  return {
    require_mention: true,
    allow_bots: "none",
    unauthorized_dm_behavior: access?.mode === "pairing" ? "pair" : "ignore",
    gateway_restart_notification: false
  };
}

export function buildHermesSurfaceConfig(surfaces: ResolvedAgentSurfaces | undefined): Record<string, unknown> {
  assertSupportedHermesSurfaces(surfaces);
  const platforms: Record<string, { enabled: boolean; extra?: Record<string, unknown> }> = Object.fromEntries(
    disabledPlatforms.map((platform) => [platform, { enabled: false }])
  );
  const config: Record<string, unknown> = { platforms, multiplex_profiles: false };
  for (const platform of chatPlatforms) {
    const surface = surfaces?.[platform];
    platforms[platform] = { enabled: false };
    if (!surface?.access) continue;

    const access = surface.access;
    const prefix = platform.toUpperCase();
    if (access?.mode === "open") config[`${prefix}_ALLOW_ALL_USERS`] = "true";
    if (access?.mode === "allowlist" && access.users.length) {
      config[`${prefix}_ALLOWED_USERS`] = access.users.join(",");
    }

    platforms[platform] = { enabled: true, extra: buildChatPolicy(access) };
  }

  if (surfaces?.telegram?.access) {
    const access = surfaces.telegram.access;
    const chats = access?.mode === "allowlist" ? access.chats : [];
    Object.assign(platforms.telegram.extra as Record<string, unknown>, {
      guest_mode: false,
      observe_unmentioned_group_messages: false,
      ...(access.mode !== "open" ? { allowed_chats: chats.length ? [...chats] : [noGroupChannel] } : {}),
      // Chat grants are an OR with user grants. Only grant the whole chat when no users were specified.
      ...(chats.length && !access.users.length ? { group_allowed_chats: [...chats] } : {})
    });
  }
  if (surfaces?.discord?.access) {
    const access = surfaces.discord.access;
    Object.assign(platforms.discord.extra as Record<string, unknown>, {
      ...(access.mode !== "open" ? { ignored_channels: ["*"], allowed_channels: ["#"] } : {}),
      thread_require_mention: true,
      allow_mentions: { everyone: false, roles: false, users: false, replied_user: false }
    });
  }
  if (surfaces?.slack?.access) {
    const access = surfaces.slack.access;
    Object.assign(platforms.slack.extra as Record<string, unknown>, {
      ...(access.mode !== "open" ? {
        allowed_channels: access.channels.length ? [...access.channels] : [noGroupChannel]
      } : {}),
      strict_mention: true,
      thread_require_mention: true
    });
  }
  return config;
}

export function buildHermesSurfaceEnvBindings(
  surfaces: ResolvedAgentSurfaces | undefined
): RuntimeContainerConfigEnvBinding[] {
  assertSupportedHermesSurfaces(surfaces);
  const bindings: RuntimeContainerConfigEnvBinding[] = chatPlatforms.flatMap((platform) => {
    const surface = surfaces?.[platform];
    return surface ? [{ envName: surface.botTokenSecret, jsonPath: ["platforms", platform, "token"] }] : [];
  });
  if (surfaces?.slack) {
    // The pinned gateway bridges root scalars before Slack reads its scoped Socket Mode credential.
    bindings.push({ envName: surfaces.slack.appTokenSecret, jsonPath: ["SLACK_APP_TOKEN"] });
  }
  return bindings;
}

// Structured bindings have already copied each member's credentials into its native config.
// Drop the original team-wide variable names before the gateway, ACP or training can read them.
const readSurfaceNames = `const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const {name} of report.secrets.surface) {
  if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(name)) process.exit(1);
  console.log(name);
}`;

const scrubSurfaceEnvironment = `names=$(node -e "$2" "$1") || exit 1
shift 2
while IFS= read -r name; do
  if [ -n "$name" ]; then unset "$name" || exit 1; fi
done <<< "$names"
while IFS= read -r spawnfile_hermes_env_name; do
  case "$spawnfile_hermes_env_name" in
    TELEGRAM_*|HERMES_TELEGRAM_*|DISCORD_*|HERMES_DISCORD_*|\\
    SLACK_*|HERMES_SLACK_*|WHATSAPP_*|GATEWAY_*|HERMES_GATEWAY_*|\\
    API_SERVER_*|WEBHOOK_*|MSGRAPH_WEBHOOK_*|HERMES_MANAGED_DIR|\\
    HERMES_CONFIG_BACKEND|HERMES_BUNDLED_PLUGINS|HERMES_ENABLE_PROJECT_PLUGINS)
      unset "$spawnfile_hermes_env_name" || exit 1
      ;;
  esac
done < <(compgen -e)
exec "$@"`;

export function buildHermesSurfaceEnvCommand(reportPath = DISTRIBUTION_REPORT_IMAGE_PATH): string[] {
  return ["bash", "-p", "-c", scrubSurfaceEnvironment, "hermes-surface-env", reportPath, readSurfaceNames];
}

export const hermesSurfaceEnvCommand = buildHermesSurfaceEnvCommand();
