import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureAuthProfile, registerNativeLogin } from "../auth/profileStore.js";
import type { ResolvedAuthProfile } from "../auth/types.js";
import { parseImageReference } from "../distribution/imageRef.js";
import { SpawnfileError } from "../shared/index.js";
import type { RuntimeTrainingLoginOptions, RuntimeTrainingLoginResult } from "./trainingTypes.js";

export interface NativeLoginFlow {
  /** The provider id in the Spawnfile model. */
  provider: string;
  command: readonly string[];
  /** The harness produces this file under a fresh, private home. */
  credentialFile: string;
  /** Optional native coordination file in the persistent grant directory. */
  persistLockFile?: "auth.lock";
  /** JavaScript expression over the parsed native file (store), limited to this provider. */
  hasLogin: string;
}

const keyFor = (runtime: string, provider: string, instance = "*") => [runtime, provider, instance].join("/");

/** Runtime adapters call this only for grants that need a single refresh owner. */
export function createLoginVolumeReservation() {
  const volumes = new Set<string>();
  return (volume: string) => {
    if (volumes.has(volume)) {
      throw new SpawnfileError("validation_error", "These agents need separate native logins. Assign each its own login with --instance.");
    }
    volumes.add(volume);
  };
}

export function nativeLoginVolume(profile: ResolvedAuthProfile | null, runtime: string, provider: string, instance: string) {
  return profile?.nativeLogins?.[keyFor(runtime, provider, instance)] ?? profile?.nativeLogins?.[keyFor(runtime, provider)];
}

async function runDocker(args: readonly string[], interactive = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: interactive ? "inherit" : ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new SpawnfileError("runtime_error", "Native login did not complete")));
  });
}

async function buildLoginImage(runtime: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-login-"));
  try {
    const { initProject } = await import("../compiler/initProject.js");
    const { buildProject } = await import("../compiler/buildProject.js");
    await initProject({ directory, runtime });
    return (await buildProject(directory, { imageTag: `spawnfile-login-${runtime}` })).imageTag;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function nativeLoginCapability(runtime: string, flows: Readonly<Record<string, NativeLoginFlow>>) {
  return {
    supportsEngine: (engine: string) => Object.hasOwn(flows, engine),
    async run(options: RuntimeTrainingLoginOptions): Promise<RuntimeTrainingLoginResult> {
      const flow = Object.hasOwn(flows, options.engine) ? flows[options.engine] : undefined;
      if (!flow || (options.instance !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(options.instance))) {
        throw new SpawnfileError("validation_error", "Invalid native login provider or instance");
      }
      if (options.image !== undefined && !parseImageReference(options.image)) {
        throw new SpawnfileError("validation_error", "Invalid native login image reference");
      }
      const profile = await ensureAuthProfile(options.profileName);
      const key = keyFor(runtime, flow.provider, options.instance);
      const suffix = createHash("sha256").update(profile.profileDirectory + "\0" + key).digest("hex").slice(0, 20);
      const volume = `spawnfile-login-${runtime}-${suffix}`;
      const image = options.image ?? await buildLoginImage(runtime);
      await runDocker(["volume", "create", "--label", "spawnfile.native-login=1", volume]);
      const mount = `type=volume,source=${volume},target=/login,volume-nocopy`;
      await runDocker(["run", "--rm", "--network", "none", "--user", "root", "--mount", mount, "--entrypoint", "sh", image,
        "-ec", "chown spawnfile:spawnfile /login && chmod 0700 /login"]);
      const persist = [
        'const fs = require("node:fs"), path = require("node:path");',
        'const source = path.join(process.env.HOME, process.argv[1]);',
        'try {',
        '  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);',
        '  let store;',
        '  try {',
        '    const stat = fs.fstatSync(fd), bytes = Buffer.alloc(65537);',
        '    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) throw new Error();',
        '    const count = fs.readSync(fd, bytes);',
        '    if (count !== stat.size || count > 65536) throw new Error();',
        '    store = JSON.parse(bytes.toString("utf8", 0, count));',
        '  } finally { fs.closeSync(fd); }',
        `  if (!(${flow.hasLogin})) throw new Error();`,
        '  const out = "/login/seed-" + require("node:crypto").randomUUID();',
        '  try { fs.writeFileSync(out, JSON.stringify(store), {mode: 0o600, flag: "wx"}); fs.renameSync(out, "/login/auth.json"); }',
        '  finally { fs.rmSync(out, {force: true}); }',
        '} catch { process.stderr.write("The native client did not save a usable private login for this provider.\\n"); process.exit(1); }'
      ].join("\n");
      // Only the login client runs with a terminal. The profile and Docker arguments receive volume names.
      const script = [
        "set -eu", "umask 077", "HOME=$(mktemp -d)", "export HOME",
        'export HERMES_HOME="$HOME/.hermes" XDG_DATA_HOME="$HOME/.local/share" XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"',
        'mkdir -p "$HERMES_HOME"', 'cd "$HOME"', 'save=$1; relative=$2; shift 2', '"$@"',
        flow.persistLockFile ? `flock -x /login/${flow.persistLockFile} node -e "$save" "$relative"` : 'node -e "$save" "$relative"'
      ].join("\n");
      const command = ["docker", "run", "--rm", "-it", "--user", "spawnfile", "--mount", mount, "--entrypoint", "flock", image,
        "-n", "/login", "sh", "-c", script, "login", persist, flow.credentialFile, ...flow.command];
      if (!options.dryRun) await runDocker(command.slice(1), true);
      return { nativeVolume: volume, command, profile: options.dryRun ? profile : await registerNativeLogin(profile.name, key, volume) };
    }
  };
}
