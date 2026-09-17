import { SpawnfileError } from "../../../shared/index.js";
import {
  DAIMON_GROK_ENGINE_BROKER,
  type DaimonGrokBrokerModel,
  type DaimonGrokBrokerReasoningEffort
} from "../../../runtime/daimon/contractManifest.js";
import type { DaimonGrokRegistration } from "../../containerDaimonGrokWorkerRender.js";
import type { TrainingBrokerDeclaration } from "./declaration.js";
import { TRAINING_SLOT_ACCEPTANCE_STORE, TRAINING_SLOT_RUNTIME_HOME, TRAINING_SLOT_WORKSPACE, TRAINING_WORKER_HOME } from "./paths.js";

/**
 * The slice of Daimon's public `@noopolis/daimon/runtime` export the slot
 * supervisor needs. Daimon stays the resolver: the slot preflight receipt binds
 * `projection_sha256`, and a second implementation of that digest would fork
 * the contract the moment either side changed a member.
 */
export interface DaimonProjectionModule {
  resolveOrganizationGrokBrokerProjection(config: unknown, agentId: string, options: Record<string, unknown>): { version: string; profileSha256: string; denyPaths: readonly string[] };
  grokBrokerProjectionSha256(projection: unknown): string;
  GROK_ENGINE_BROKER: { projectionVersion: string; slotPreflightVersion: string; nativeAbiVersion: number };
}

/** Indirect specifier: Daimon is an in-image runtime peer of the training container, never a Spawnfile source dependency. */
const loadRuntime = async (): Promise<unknown> => {
  const packageName = "@noopolis/daimon/runtime";
  return import(packageName);
};

export const loadDaimonProjectionModule = async (load: () => Promise<unknown> = loadRuntime): Promise<DaimonProjectionModule> => {
  let daimon: DaimonProjectionModule;
  try { daimon = await load() as DaimonProjectionModule; }
  catch { throw new SpawnfileError("runtime_error", "The training image must install @noopolis/daimon with its public /runtime export"); }
  if (typeof daimon.resolveOrganizationGrokBrokerProjection !== "function" || typeof daimon.grokBrokerProjectionSha256 !== "function"
    || daimon.GROK_ENGINE_BROKER?.projectionVersion !== DAIMON_GROK_ENGINE_BROKER.projectionVersion
    || daimon.GROK_ENGINE_BROKER.slotPreflightVersion !== DAIMON_GROK_ENGINE_BROKER.slotPreflightVersion
    || daimon.GROK_ENGINE_BROKER.nativeAbiVersion !== DAIMON_GROK_ENGINE_BROKER.nativeAbiVersion) {
    throw new SpawnfileError("runtime_error", "The installed Daimon Grok broker contract differs from this compiler's vendored manifest");
  }
  return daimon;
};

/**
 * The one-agent organization runtime config the training slot's projection is
 * resolved from. It is a projection *input*, never a runtime config Daimon
 * hosts: the trial's real config is Paideia's, and both describe the same
 * single agent at the same fixed container paths, so both compute the same
 * projection digest. A peer agent would change Daimon's protected set and the
 * digest with it, which is exactly why training runs one slot.
 */
export const trainingOrganizationRuntimeConfig = (declaration: {
  agentId: string; model: DaimonGrokBrokerModel; reasoningEffort: DaimonGrokBrokerReasoningEffort;
}): Record<string, unknown> => ({
  version: "noopolis.daimon.organization-runtime.v2",
  id: "daimon-organization",
  agents: [{
    id: declaration.agentId,
    name: declaration.agentId,
    instructions: "",
    workspacePath: TRAINING_SLOT_WORKSPACE,
    runtimeHomePath: TRAINING_SLOT_RUNTIME_HOME,
    engine: { kind: "grok", model: declaration.model, reasoningEffort: declaration.reasoningEffort }
  }]
});

export interface TrainingGrokProjection { projection: Record<string, unknown>; projectionSha256: string }

/**
 * Resolve the slot's public Grok broker projection through Daimon, over exactly
 * the provisioned registration. A profile digest that differs from Daimon's own
 * render is refused there, so the receipt can never certify a slot whose deny
 * list drifted from the bytes provisioning wrote.
 */
export const resolveTrainingGrokProjection = async (
  declaration: TrainingBrokerDeclaration,
  registration: DaimonGrokRegistration,
  daimon: DaimonProjectionModule
): Promise<TrainingGrokProjection> => {
  const projection = daimon.resolveOrganizationGrokBrokerProjection(
    trainingOrganizationRuntimeConfig(declaration), declaration.agentId, {
      slot: registration.slot,
      workerUid: registration.uid,
      workerHomePath: TRAINING_WORKER_HOME,
      architecture: declaration.architecture,
      usageLedgerPath: registration.usageLedgerPath,
      limits: declaration.limits,
      acceptanceStorePath: TRAINING_SLOT_ACCEPTANCE_STORE,
      denyPaths: registration.denyPaths,
      seccompProfileSha256: declaration.seccompProfileSha256,
      profileSha256: registration.profileSha256
    }) as unknown as Record<string, unknown>;
  const denied = [...(projection.denyPaths as string[])];
  if (denied.length !== registration.denyPaths.length || denied.some((entry, index) => entry !== registration.denyPaths[index])) {
    throw new SpawnfileError("runtime_error", "Daimon's Grok broker projection deny list differs from the provisioned sandbox profile");
  }
  return { projection, projectionSha256: daimon.grokBrokerProjectionSha256(projection) };
};
