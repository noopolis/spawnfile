import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureAuthProfile, registerSubscriptionRealm, type ResolvedAuthProfile, type SubscriptionRealmBinding } from "../../../auth/index.js";
import { getDaimonEngineDescriptor } from "../../../runtime/daimon/index.js";
import { DAIMON_ORGANIZATION_UID } from "../../../runtime/daimon/runtimeIdentity.js";
import { DAIMON_PROFILE_UNLOCK_FILE } from "../../../runtime/daimon/subscriptionRealms.js";
import { SpawnfileError } from "../../../shared/index.js";
import { slugify } from "../../helpers.js";
import { prepareTrial, type PreparedTrial } from "./boot.js";
import { createTrialDocker, type TrialDocker } from "./docker.js";
import { trainingGatewayRealmVolume } from "./gateway.js";
import { JUDGE_INSTRUCTIONS, writeJudgeAgent } from "./judge.js";

const LABEL = "spawnfile.subscription-realm";

export interface SubscriptionRealmLoginOptions {
  profileName: string;
  engine: string;
  /** Prepare volumes and image and return the login command without running it or recording the login. */
  dryRun?: boolean;
  docker?: TrialDocker;
  /** Where the throwaway login organization is compiled (default: a fresh temp directory). */
  scratchRoot?: string;
  /** Builds the throwaway one-agent organization the login runs in (tests only). */
  prepare?: typeof prepareTrial;
}

export interface SubscriptionRealmLoginResult {
  binding: SubscriptionRealmBinding;
  /** The exact `docker run` argv the login uses. */
  command: readonly string[];
  profile: ResolvedAuthProfile;
}

/** The profile's volume names for an engine's volume-held login. */
export const subscriptionRealmBinding = (profileName: string, engine: string): SubscriptionRealmBinding => ({
  realmVolume: trainingGatewayRealmVolume(profileName, engine),
  unlockVolume: `spawnfile-training-${slugify(profileName) || "profile"}-${engine}-unlock`
});

/**
 * Creates the unlock secret inside its volume exactly once, as the organization
 * uid Daimon checks it against (one `0600` regular file, no newline). Generated
 * and written inside a network-less container: the bytes never reach the host.
 * An existing secret is kept (replacing it would orphan the encrypted keyring)
 * unless it is unsafe, which is refused.
 */
const UNLOCK_PROGRAM = [
  "const fs = require('node:fs'), crypto = require('node:crypto');",
  "const [uid, name] = process.argv.slice(1); const target = `/unlock/${name}`;",
  "try { const entry = fs.lstatSync(target);",
  "  if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== Number(uid) || (entry.mode & 0o777) !== 0o600 || entry.size < 1) { console.error('existing unlock secret is unsafe'); process.exit(3); }",
  "  process.exit(0);",
  "} catch (error) { if (error.code !== 'ENOENT') throw error; }",
  "const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);",
  "const bytes = Buffer.from(crypto.randomBytes(32).toString('hex'));",
  "fs.writeSync(fd, bytes); bytes.fill(0); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); fs.fchownSync(fd, Number(uid), Number(uid)); fs.closeSync(fd);"
].join("\n");

export const ensureSubscriptionRealmVolumes = async (
  docker: TrialDocker,
  image: string,
  engine: string,
  binding: SubscriptionRealmBinding
): Promise<void> => {
  for (const volume of [binding.realmVolume, binding.unlockVolume]) {
    await docker(["volume", "create", "--label", `${LABEL}=${engine}`, volume]);
  }
  await docker(["run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN",
    "--security-opt", "no-new-privileges", "--entrypoint", "node", "--mount", `type=volume,source=${binding.unlockVolume},target=/unlock`,
    image, "-e", UNLOCK_PROGRAM, String(DAIMON_ORGANIZATION_UID), DAIMON_PROFILE_UNLOCK_FILE]);
};

/**
 * `spawnfile auth login <engine>`: gives an auth profile its own volume-held
 * login for an engine that keeps its login in a Daimon secret-service realm
 * (AGY). Creates the profile's realm and unlock volumes, then runs Daimon's
 * own interactive `auth <engine> login` in a throwaway, production-booted
 * one-agent organization (a tool-free judge) attached to the operator's
 * terminal, and records the volume names on the profile once it succeeds.
 * Spawnfile never reads the login or the unlock secret.
 */
export const loginSubscriptionRealm = async (options: SubscriptionRealmLoginOptions): Promise<SubscriptionRealmLoginResult> => {
  const descriptor = getDaimonEngineDescriptor(options.engine);
  if (descriptor?.auth.staging !== "secret-service") {
    throw new SpawnfileError("validation_error", `Engine ${options.engine} has no volume-held login; use \`spawnfile auth import ${options.engine}\``);
  }
  const docker = options.docker ?? createTrialDocker();
  const current = await ensureAuthProfile(options.profileName);
  const binding = current.realms?.[options.engine] ?? subscriptionRealmBinding(current.name, options.engine);
  const realms: ResolvedAuthProfile = { ...current, env: {}, imports: {}, realms: { [options.engine]: binding } };
  const scratch = options.scratchRoot ?? os.tmpdir();
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "spawnfile-auth-login-"));
  let prepared: PreparedTrial | undefined;
  try {
    prepared = await (options.prepare ?? prepareTrial)({
      agentManifestPath: await writeJudgeAgent({ engine: options.engine, model: "default" }, path.join(root, "source")),
      directory: root, docker, instructions: JUDGE_INSTRUCTIONS, trialId: `login-${options.engine}-${current.name}`
    });
    await ensureSubscriptionRealmVolumes(docker, prepared.image, options.engine, binding);
    const command = await prepared.login(realms, { dryRun: options.dryRun === true });
    const profile = options.dryRun ? current : await registerSubscriptionRealm(current.name, options.engine, binding);
    return { binding, command, profile };
  } finally {
    await prepared?.dispose();
    await rm(root, { recursive: true, force: true });
  }
};
