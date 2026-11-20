import type { EffectiveModelTarget } from "../../compiler/types.js";
import { opencodeOwnerFile } from "./acpOwner.js";
import { opencodeLoginDirectory, openCodeSubscriptionProvider } from "./auth.js";
import { usableOpenCodeLogin } from "./storeFormat.js";

export const opencodeLaunchFile = "opencode-launch.sh";

export function renderOpenCodeLaunch(target: EffectiveModelTarget | undefined, ownsAcp = false): string {
  const head = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "umask 077",
    "unset OPENCODE_AUTH_CONTENT OPENCODE_CONFIG_CONTENT"
  ].join("\n") + "\n";
  const provider = openCodeSubscriptionProvider(target);
  if (!provider) return head + 'exec "$@"\n';

  const credentialEnv = { openai: "OPENAI_API_KEY", xai: "XAI_API_KEY", "github-copilot": "GITHUB_TOKEN GH_TOKEN COPILOT_GITHUB_TOKEN" };
  const attach = ownsAcp ? String.raw`if [ "$2" = acp ]; then
  if [ "$#" -ne 8 ] || [ "$7" != --cwd ]; then
    echo "OpenCode ACP requires the compiled bridge arguments." >&2
    exit 1
  fi
  exec node "$HOME/${opencodeOwnerFile}" attach "$8"
fi
` : "";
  return head + attach + String.raw`unset ${credentialEnv[provider]} OPENCODE_MODELS_PATH OPENCODE_CONFIG_DIR
login_dir="$HOME/${opencodeLoginDirectory}"
if [ "$2" != serve ]; then
  echo "OpenCode subscription clients must connect to the instance service." >&2
  exit 1
fi
if [ ! -d "$login_dir" ]; then
  echo "OpenCode needs a native login volume." >&2
  exit 1
fi
binary=$1
shift 2
login_lock=9
exec 9<"$login_dir"
/usr/bin/flock --exclusive --nonblock --conflict-exit-code 73 "$login_lock"

node - "$login_dir" "$binary" "${provider}" <<'OPEN_CODE_LOGIN'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const [loginDir, binary, provider] = process.argv.slice(2);
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
    const store = JSON.parse(bytes.toString("utf8", 0, count));
    if (!${usableOpenCodeLogin(provider)}) throw new Error();
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
OPEN_CODE_LOGIN
` + (ownsAcp
    ? String.raw`exec node "$HOME/${opencodeOwnerFile}" owner "$binary" "$login_lock" "$@"` + "\n"
    : 'exec "$binary" serve "$@"\n');
}
