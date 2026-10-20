import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { daimonAgentSkillsFromResolved, parseDaimonAgentSkills, type DaimonAgentSkill } from "../../../runtime/daimon/grokWorkerSkills.js";
import { SpawnfileError } from "../../../shared/index.js";
import type { TrainingContext } from "../contract.js";

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
 * Lowers `spawnfile.training-container.v4`'s broker block into the read-only
 * `spawnfile.training-broker.v2` declaration the container's own root
 * entrypoint reads, plus the launch bindings that carry the realm volume and
 * bootstrap leaf.
 *
 * The bootstrap is checked here as well as at launch: a run that never reaches
 * `docker create` — a dry run, a failed build — must still refuse the
 * developer's desktop Grok login rather than report it later.
 */
/**
 * The subject's declared skills, read from the context's pinned sources and
 * refused if any byte changed since capture: exactly the `SKILL.md` files the
 * compiler emits into its `.agents/skills`, in Daimon's engine-neutral form.
 * `undefined` for none keeps a skill-less declaration byte-identical.
 */
export const trainingBrokerSkills = async (context: Pick<TrainingContext, "skills">): Promise<DaimonAgentSkill[] | undefined> => {
  if (context.skills.length === 0) return undefined;
  const skills = await Promise.all(context.skills.map(async (skill) => {
    const bytes = await readFile(skill.sourcePath);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== skill.sha256) {
      throw new SpawnfileError("validation_error", `Training skill ${skill.name} changed since its context was captured`);
    }
    return { name: skill.name, content: bytes.toString("utf8") };
  }));
  return parseDaimonAgentSkills(daimonAgentSkillsFromResolved(skills));
};

export const prepareTrainingBroker = async (
  broker: NonNullable<TrainingPreparationConfig["broker"]>,
  root: string,
  staging: string,
  write: boolean,
  slots = 4,
  skills?: readonly DaimonAgentSkill[]
): Promise<PreparedTrainingBroker> => {
  const bootstrap = path.resolve(root, broker.bootstrap);
  assertNotDesktopGrokAuth(bootstrap);
  const info = await lstat(bootstrap).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw Error("The training Grok bootstrap must be an existing regular credential leaf");
  if ((info.mode & 0o077) !== 0) throw Error("The training Grok bootstrap must not be group- or world-accessible");
  const declaration = parseTrainingBrokerDeclaration({
    version: "spawnfile.training-broker.v2",
    slots,
    maxRunRequests: broker.maxRunRequests,
    engine: broker.engine,
    agentId: broker.agentId,
    model: broker.model,
    reasoningEffort: broker.reasoningEffort,
    architecture: broker.architecture,
    limits: broker.limits,
    bootstrap: TRAINING_BOOTSTRAP_MOUNT,
    organizationUid: DAIMON_ORGANIZATION_UID,
    seccompProfileSha256: DAIMON_GROK_SECCOMP_PROFILE_SHA256,
    ...(broker.unenforcedBindPolicy === undefined ? {} : { unenforcedBindPolicy: broker.unenforcedBindPolicy }),
    ...(skills?.length ? { skills } : {})
  });
  const declarationPath = path.join(staging, "training-broker.json");
  if (write) await writeFile(declarationPath, `${JSON.stringify(declaration)}\n`, { mode: 0o444, flag: "wx" });
  return { declarationPath, launch: { engine: "grok", realmVolume: broker.realmVolume, bootstrap, declaration: declarationPath } };
};
