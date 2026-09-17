import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";

import { DAIMON_GROK_SECCOMP_PROFILE_SHA256 } from "../../../shared/daimonGrokSeccompProfile.js";
import { assertNotDesktopGrokAuth } from "../broker/entrypoint.js";
import { parseTrainingBrokerDeclaration } from "../broker/declaration.js";
import { TRAINING_BOOTSTRAP_MOUNT } from "../broker/paths.js";
import { DAIMON_ORGANIZATION_UID } from "../../../runtime/daimon/runtimeIdentity.js";
import type { TrainingPreparationConfig } from "./contract.js";

export interface PreparedTrainingBroker {
  declarationPath: string;
  launch: { engine: "grok"; realmVolume: string; bootstrap: string; declaration: string };
}

/**
 * Lowers `spawnfile.training-container.v3`'s broker block into the read-only
 * `spawnfile.training-broker.v1` declaration the container's own root
 * entrypoint reads, plus the launch bindings that carry the realm volume and
 * bootstrap leaf.
 *
 * The bootstrap is checked here as well as at launch: a run that never reaches
 * `docker create` — a dry run, a failed build — must still refuse the
 * developer's desktop Grok login rather than report it later.
 */
export const prepareTrainingBroker = async (
  broker: NonNullable<TrainingPreparationConfig["broker"]>,
  root: string,
  staging: string,
  write: boolean
): Promise<PreparedTrainingBroker> => {
  const bootstrap = path.resolve(root, broker.bootstrap);
  assertNotDesktopGrokAuth(bootstrap);
  const info = await lstat(bootstrap).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw Error("The training Grok bootstrap must be an existing regular credential leaf");
  if ((info.mode & 0o077) !== 0) throw Error("The training Grok bootstrap must not be group- or world-accessible");
  const declaration = parseTrainingBrokerDeclaration({
    version: "spawnfile.training-broker.v1",
    engine: broker.engine,
    agentId: broker.agentId,
    model: broker.model,
    reasoningEffort: broker.reasoningEffort,
    architecture: broker.architecture,
    limits: broker.limits,
    bootstrap: TRAINING_BOOTSTRAP_MOUNT,
    organizationUid: DAIMON_ORGANIZATION_UID,
    seccompProfileSha256: DAIMON_GROK_SECCOMP_PROFILE_SHA256,
    ...(broker.unenforcedBindPolicy === undefined ? {} : { unenforcedBindPolicy: broker.unenforcedBindPolicy })
  });
  const declarationPath = path.join(staging, "training-broker.json");
  if (write) await writeFile(declarationPath, `${JSON.stringify(declaration)}\n`, { mode: 0o444, flag: "wx" });
  return { declarationPath, launch: { engine: "grok", realmVolume: broker.realmVolume, bootstrap, declaration: declarationPath } };
};
