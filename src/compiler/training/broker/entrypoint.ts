import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SpawnfileError } from "../../../shared/index.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { parseTrainingBrokerDeclaration, type TrainingBrokerDeclaration } from "./declaration.js";
import { loadDaimonProjectionModule, resolveTrainingGrokProjection, type DaimonProjectionModule } from "./projection.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { createTrainingSlotRuntime } from "./runtime.js";
import { createTrainingSlotSupervisor, serveTrainingSlotSupervisor, startTrainingSlot } from "./supervisor.js";
import {
  DAIMON_ORGANIZATION_UID,
  TRAINING_BOOTSTRAP_MOUNT,
  TRAINING_BROKER_DECLARATION_FILE,
  TRAINING_GRANT_HOME_ROOT,
  TRAINING_SUPERVISOR_SOCKET
} from "./paths.js";

export const TRAINING_GROK_BROKER_CONTROL_SOCKET_ENV = "PAIDEIA_GROK_BROKER_CONTROL_SOCKET";
export const TRAINING_GROK_GRANT_HOME_ROOT_ENV = "PAIDEIA_GROK_GRANT_HOME_ROOT";
export const TRAINING_ENTRYPOINT_COMMAND = "/opt/training/bin/train";

/**
 * The desktop Grok login, in every spelling a caller might reach it by.
 *
 * D2 is explicit: training uses one dedicated Grok login and never the
 * developer's own. An in-container refresh rotates the credential, so mounting
 * the desktop leaf would invalidate the developer's desktop session as a side
 * effect of a training run — and the refreshed token would live on tmpfs, so
 * the desktop login would be gone rather than moved.
 */
export const desktopGrokAuthPaths = (home = os.homedir()): string[] =>
  [path.resolve(home, ".grok/auth.json"), path.resolve(home, ".grok", "auth.json")];

export const assertNotDesktopGrokAuth = (source: string, home = os.homedir()): string => {
  if (desktopGrokAuthPaths(home).includes(path.resolve(source))) {
    throw new SpawnfileError("validation_error",
      "Training refuses the desktop ~/.grok/auth.json as its Grok bootstrap; import a dedicated login with `spawnfile auth import grok --profile paideia-training --from <dir>`");
  }
  return source;
};

/** The bootstrap leaf inside the container: the fixed read-only mount, a bounded regular file, never a symlink. */
const assertBootstrap = async (declaration: TrainingBrokerDeclaration): Promise<void> => {
  if (declaration.bootstrap !== TRAINING_BOOTSTRAP_MOUNT) {
    throw new SpawnfileError("validation_error", `The training Grok bootstrap must be mounted at ${TRAINING_BOOTSTRAP_MOUNT}`);
  }
  const info = await lstat(declaration.bootstrap);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > DAIMON_GROK_SUBSCRIPTION_MAX_BYTES) {
    throw new SpawnfileError("validation_error", "The training Grok bootstrap must be a bounded regular credential leaf");
  }
};
const DAIMON_GROK_SUBSCRIPTION_MAX_BYTES = 64 * 1024;

export interface TrainingEntrypointOptions {
  argv: readonly string[];
  declarationPath?: string;
  loadDaimon?: () => Promise<DaimonProjectionModule>;
  log?: (line: string) => void;
}

/**
 * The broker-capable training container's root entrypoint.
 *
 * Order matters and is the whole privilege model: provision as root with the
 * production capability set, start the launcher (root) and the broker and
 * relay (2100) and prove each one's post-drop identity, publish the slot
 * supervisor socket, and only then drop to uid 2000 with an empty capability
 * bounding set to run `train`. Paideia, DSPy and the judges are that uid; the
 * model's own tools are the worker uid the launcher alone can reach.
 */
export const runTrainingBrokerEntrypoint = async (options: TrainingEntrypointOptions): Promise<number> => {
  const log = options.log ?? ((line: string) => process.stderr.write(`[training-entrypoint] ${line}\n`));
  if (process.getuid?.() !== 0) throw new SpawnfileError("runtime_error", "The broker-capable training container must start as root");
  const declaration = parseTrainingBrokerDeclaration(JSON.parse(await readFile(options.declarationPath ?? TRAINING_BROKER_DECLARATION_FILE, "utf8")));
  await assertBootstrap(declaration);
  const registration = resolveTrainingGrokRegistration(declaration);
  const daimon = await (options.loadDaimon ?? loadDaimonProjectionModule)();
  // Daimon's projection is I/O-free, so the digest the receipt will bind is known before anything is provisioned.
  const { projectionSha256 } = await resolveTrainingGrokProjection(declaration, registration, daimon);
  const runtime = createTrainingSlotRuntime({ declaration, registration, projectionSha256 });
  // Provision, start, canary and publish the slot preflight receipt before `train` exists at all: the
  // first trial must not be the one trial that runs on no worker-uid denial evidence, and a refusal
  // here costs nothing while the same refusal after the first wake costs that trial's spend.
  const preflight = await startTrainingSlot(runtime, randomBytes(32).toString("hex"));
  const supervisor = createTrainingSlotSupervisor({ runtime, organizationUid: declaration.organizationUid });
  const server = serveTrainingSlotSupervisor(supervisor, TRAINING_SUPERVISOR_SOCKET, log, declaration.organizationUid);
  log(`slot ${registration.slot} provisioned for ${registration.agentId} (${registration.model}/${registration.reasoningEffort}), projection ${projectionSha256}, `
    + `generation ${preflight.generation} with ${preflight.canaries} denied canaries at ${preflight.receipt}`);
  const status = await runTrainingChild(options.argv, declaration, log);
  server.close();
  await runtime.stop();
  return status;
};

/**
 * `train` as uid 2000 with an empty bounding set, proven inside the child
 * before it execs: `setpriv --bounding-set=-all` silently does nothing without
 * `CAP_SETPCAP`, so the guard has to read `/proc/self/status` rather than
 * trust the flag.
 */
export const trainingChildArgv = (argv: readonly string[], uid = DAIMON_ORGANIZATION_UID): string[] => [
  "setpriv", "--clear-groups", `--reuid=${uid}`, `--regid=${uid}`, "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all",
  "--", "/bin/bash", "-ceu",
  'if [ "$EUID" -eq 0 ]; then echo "training must not run as root" >&2; exit 1; fi\n'
  + 'test "$(sed -n "s/^CapBnd:[[:space:]]*//p" /proc/self/status)" = 0000000000000000\n'
  + 'test "$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)" = 0000000000000000\n'
  + 'exec "$@"',
  "bash", TRAINING_ENTRYPOINT_COMMAND, ...argv
];

const runTrainingChild = (argv: readonly string[], declaration: TrainingBrokerDeclaration, log: (line: string) => void): Promise<number> =>
  new Promise((resolve) => {
    const command = trainingChildArgv(argv, declaration.organizationUid);
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        [TRAINING_GROK_BROKER_CONTROL_SOCKET_ENV]: DAIMON_GROK_ENGINE_BROKER.controlSocketPath,
        [TRAINING_GROK_GRANT_HOME_ROOT_ENV]: TRAINING_GRANT_HOME_ROOT,
        HOME: "/home/training"
      }
    });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, forward(signal));
    child.once("exit", (code, signal) => {
      log(`training exited code=${code ?? "null"} signal=${signal ?? "none"}`);
      resolve(signal ? (signal === "SIGINT" ? 130 : 143) : code ?? 1);
    });
  });
