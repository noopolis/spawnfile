import {
  DAIMON_DOCKER_RUNTIME_SECURITY_ARGS,
  materializeDaimonGrokSeccompProfile
} from "../../../shared/index.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../../../runtime/daimon/contractManifest.js";
import { DAIMON_WAKE_FUSE_DIRECTORY } from "../../../runtime/daimon/config.js";
import {
  TRAINING_BROKER_TMPDIR,
  TRAINING_GRANT_HOME_ROOT,
  TRAINING_INFERENCE_DIRECTORY,
  TRAINING_PAIDEIA_ROOT,
  TRAINING_SLOT_ROOT,
  TRAINING_SUPERVISOR_DIRECTORY,
  TRAINING_WORKER_ROOT
} from "../broker/paths.js";

export const TRAINING_BROKER_ENTRYPOINT = "/opt/training/bin/train-broker";

/**
 * Writable state of a broker-capable training container, all on tmpfs.
 *
 * The image root stays read-only and nothing here is a host bind, so a trial's
 * worker home, workspace, turn store, wake-acceptance store and ledgers are
 * on a filesystem that enforces unix ownership — which is what lets the slot
 * supervisor's worker-uid canaries mean anything (P0 §5: a host bind under
 * Docker Desktop or Colima silently ignores `chown`). The Grok realm is the
 * one durable mount, and it is a named volume, not a bind.
 */
export const trainingBrokerTmpfsTargets = (): readonly { path: string; size: string; mode: string }[] => [
  { path: "/tmp", size: "1g", mode: "1777" },
  { path: "/var/tmp", size: "256m", mode: "1777" },
  { path: "/work", size: "4g", mode: "0755" },
  { path: "/home/training", size: "1g", mode: "0755" },
  { path: TRAINING_PAIDEIA_ROOT, size: "64m", mode: "0755" },
  { path: TRAINING_SLOT_ROOT, size: "4g", mode: "0755" },
  { path: TRAINING_GRANT_HOME_ROOT, size: "64m", mode: "0755" },
  { path: TRAINING_INFERENCE_DIRECTORY, size: "64m", mode: "0755" },
  { path: TRAINING_SUPERVISOR_DIRECTORY, size: "16m", mode: "0755" },
  { path: TRAINING_WORKER_ROOT, size: "1g", mode: "0755" },
  { path: "/etc/daimon-engine-broker", size: "16m", mode: "0755" },
  { path: "/run/daimon-engine-broker", size: "64m", mode: "0755" },
  { path: TRAINING_BROKER_TMPDIR, size: "64m", mode: "0755" },
  { path: DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath, size: "64m", mode: "0755" },
  { path: DAIMON_WAKE_FUSE_DIRECTORY, size: "16m", mode: "0755" }
];

/**
 * `docker create` arguments for the broker-capable training container.
 *
 * It starts as root with the *production* Daimon capability set rather than
 * the v1 path's `--cap-drop ALL` as the host user: the root entrypoint has to
 * provision uid-owned directories (`CAP_CHOWN`), let the native launcher
 * `setuid` to a worker (`CAP_SETUID`/`SETGID`), drop bounding sets
 * (`CAP_SETPCAP`), supervise dropped children (`CAP_KILL`) and read the
 * attested layout it does not own (`CAP_DAC_READ_SEARCH`). `CAP_FOWNER` is
 * deliberately absent, which is why every provisioning chmod reclaims the
 * inode first. Grok 1.0.34 runs every sandbox profile inside bubblewrap, so
 * the container also needs the pinned default-plus-userns seccomp profile and
 * AppArmor unconfined — the narrowest combination P0 found.
 */
export const trainingBrokerSecurityArgs = async (seccompProfileDirectory: string): Promise<string[]> => [
  "--user", "0:0",
  ...DAIMON_DOCKER_RUNTIME_SECURITY_ARGS,
  `--security-opt=seccomp=${await materializeDaimonGrokSeccompProfile(seccompProfileDirectory)}`,
  "--security-opt=apparmor=unconfined"
];

export const trainingBrokerMounts = (broker: { realmVolume: string; bootstrap: string; declaration: string }): string[] => [
  `type=volume,src=${broker.realmVolume},dst=${DAIMON_GROK_ENGINE_BROKER.credentialHomePath}`,
  `type=bind,src=${broker.bootstrap},dst=/var/lib/spawnfile/daimon/grok-bootstrap-auth,readonly`,
  `type=bind,src=${broker.declaration},dst=${TRAINING_PAIDEIA_ROOT}/training-broker.json,readonly`
];
