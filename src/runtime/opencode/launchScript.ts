import type { EffectiveModelTarget } from "../../compiler/types.js";
import { opencodeLoginDirectory, openCodeSubscriptionProvider } from "./auth.js";

export const opencodeLaunchFile = "opencode-launch.sh";

export function renderOpenCodeLaunch(target: EffectiveModelTarget | undefined): string {
  const head = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "umask 077",
    "unset OPENCODE_AUTH_CONTENT OPENCODE_CONFIG_CONTENT"
  ].join("\n") + "\n";
  const provider = openCodeSubscriptionProvider(target);
  if (!provider) return head + 'exec "$@"\n';

  const credentialEnv = { openai: "OPENAI_API_KEY", xai: "XAI_API_KEY", "github-copilot": "GITHUB_TOKEN GH_TOKEN COPILOT_GITHUB_TOKEN" };
  return head + String.raw`unset ${credentialEnv[provider]} OPENCODE_MODELS_PATH OPENCODE_CONFIG_DIR
login_dir="$HOME/${opencodeLoginDirectory}"
if [ "$2" = serve ]; then
  # Hold the reservation for the Docker unit while its ACP or training client uses it.
  if [ ! -d "$login_dir" ]; then
    echo "OpenCode needs a native login volume." >&2
    exit 1
  fi
  binary=$1
  shift 2
  exec /usr/bin/flock --exclusive --nonblock --no-fork --conflict-exit-code 73 \
    "$login_dir" /bin/bash "$0" "$binary" spawnfile-serve "$@"
fi

node - "$login_dir" "$1" "$2" "${provider}" <<'OPEN_CODE_LOGIN'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const [loginDir, binary, command, provider] = process.argv.slice(2);
const maxBytes = 65536;
const source = path.join(loginDir, "auth.json");
const data = path.join(process.env.XDG_DATA_HOME, "opencode");

function privateOwned(stat, mode) {
  return stat.uid === process.getuid() && (stat.mode & 0o7777) === mode;
}

try {
  const directory = fs.lstatSync(loginDir);
  if (!directory.isDirectory() || !privateOwned(directory, 0o700)) throw new Error();
  fs.accessSync(loginDir, fs.constants.W_OK);
  const fd = fs.openSync(source, fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_RDWR);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !privateOwned(stat, 0o600) || stat.nlink !== 1) throw new Error();
    const bytes = Buffer.alloc(maxBytes + 1);
    const count = fs.readSync(fd, bytes);
    if (count !== stat.size || count > maxBytes) throw new Error();
    const native = JSON.parse(bytes.toString("utf8", 0, count));
    const auth = native[provider];
    const token = value => typeof value === "string" && /^\S+$/u.test(value);
    if (Object.keys(native).length !== 1 || auth?.type !== "oauth" || !token(auth.refresh)
      || !(token(auth.access) || (provider === "openai" && auth.access === ""))
      || !Number.isSafeInteger(auth.expires) || auth.expires < 0
      || (auth.accountId !== undefined && !token(auth.accountId))
      || (auth.enterpriseUrl !== undefined && typeof auth.enterpriseUrl !== "string")) throw new Error();
  } finally {
    fs.closeSync(fd);
  }

  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const link = path.join(data, "auth.json");
  try {
    fs.symlinkSync(source, link);
  } catch (error) {
    if (error.code !== "EEXIST" || fs.readlinkSync(link) !== source) throw error;
  }
} catch {
  process.stderr.write("OpenCode needs a usable native " + provider + " OAuth login in its writable login volume (0700 directory, 0600 auth.json owned by the runtime user).\n");
  process.exit(1);
}

if (command === "spawnfile-serve") {
  try {
    const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
    const catalog = execFileSync(binary, ["models", provider, "--verbose"], {
      // Resolve against the pinned catalog before the authored model override is merged.
      env: { ...process.env, OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: [provider] }) },
      encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
    });
    const lines = catalog.split(new RegExp("^" + provider + "/", "mu")).slice(1);
    if (!config.model.startsWith(provider + "/")) throw new Error();
    const model = lines.find(entry => entry.startsWith(config.model.slice(provider.length + 1) + "\n"));
    if (!model) throw new Error();
    const metadata = JSON.parse(model.slice(model.indexOf("\n") + 1));
    const effort = config.agent?.build?.variant;
    if (!metadata.capabilities?.toolcall ||
      (effort !== undefined && metadata.variants?.[effort]?.reasoningEffort !== effort)) throw new Error();
  } catch {
    process.stderr.write("OpenCode's pinned " + provider + " catalog does not provide the declared model and reasoning effort.\n");
    process.exit(1);
  }
}
OPEN_CODE_LOGIN
if [ "$2" = spawnfile-serve ]; then
  binary=$1
  shift 2
  exec "$binary" serve "$@"
fi
exec "$@"
`;
}
