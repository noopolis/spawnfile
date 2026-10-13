import { SpawnfileError } from "../../../shared/index.js";
import {
  DAIMON_GROK_ENGINE_BROKER,
  type DaimonGrokBrokerModel,
  type DaimonGrokBrokerReasoningEffort
} from "../../../runtime/daimon/contractManifest.js";
import type { DaimonGrokRegistration } from "../../containerDaimonGrokWorkerRender.js";
import type { TrainingBrokerDeclaration } from "./declaration.js";
import { trainingSlotPaths } from "./paths.js";

/**
 * The slice of Daimon's public `@noopolis/daimon/runtime` export the slot
 * supervisor needs. Daimon stays the resolver: the slot preflight receipt binds
 * `projection_sha256`, and a second implementation of that digest would fork
 * the contract the moment either side changed a member.
 */
export interface DaimonProjectionModule {
  resolveOrganizationGrokBrokerProjection(config: unknown, agentId: string, options: Record<string, unknown>): { version: string; profileSha256: string; denyPaths: readonly string[] };
  grokBrokerProjectionSha256(projection: unknown): string;
  GROK_ENGINE_BROKER: { projectionVersion: string; slotPreflightVersion: string; nativeAbiVersion: number; controlProtocolVersion: string };
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
    || daimon.GROK_ENGINE_BROKER.controlProtocolVersion !== DAIMON_GROK_ENGINE_BROKER.controlProtocolVersion
    || daimon.GROK_ENGINE_BROKER.slotPreflightVersion !== DAIMON_GROK_ENGINE_BROKER.slotPreflightVersion
    || daimon.GROK_ENGINE_BROKER.nativeAbiVersion !== DAIMON_GROK_ENGINE_BROKER.nativeAbiVersion) {
    throw new SpawnfileError("runtime_error", "The installed Daimon Grok broker contract differs from this compiler's vendored manifest");
  }
  return daimon;
};

/**
 * The one-agent organization runtime config the training slot's projection is
 * resolved from.
 *
 * It is a projection *input*, never a runtime config Daimon hosts: the trial's
 * real config is Paideia's. Only `agents[].id`, `workspacePath`,
 * `runtimeHomePath`, the engine's declared model and effort, and the *absence*
 * of peers reach `resolveOrganizationGrokBrokerProjection`, so this minimal
 * config and Paideia's fuller one compute the same projection digest. A peer
 * agent would change Daimon's protected set and the digest with it, which is
 * why each slot resolves its own one-agent projection with explicit sibling deny paths.
 */
export const trainingOrganizationRuntimeConfig = (declaration: {
  agentId: string; model: DaimonGrokBrokerModel; reasoningEffort: DaimonGrokBrokerReasoningEffort;
}, slot = 0): Record<string, unknown> => ({
  version: "noopolis.daimon.organization-runtime.v1",
  host: { bindHost: "127.0.0.1", port: trainingSlotPaths(slot).ports.workerControl, controlTokenEnv: "SPAWNFILE_DAIMON_CONTROL_TOKEN" },
  agents: [{
    id: declaration.agentId,
    name: declaration.agentId,
    instructions: "training subject",
    workspacePath: trainingSlotPaths(slot).workspace,
    runtimeHomePath: trainingSlotPaths(slot).runtimeHome,
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
    trainingOrganizationRuntimeConfig(declaration, registration.slot), declaration.agentId, {
      slot: registration.slot,
      workerConfigVariant: "clocked",
      workerUid: registration.uid,
      workerHomePath: registration.home,
      architecture: declaration.architecture,
      usageLedgerPath: registration.usageLedgerPath,
      limits: declaration.limits,
      // The mask that protects the wake-acceptance store is the slot state root it lives in: the store's
      // own parent is `2000:2000 0700`, so bubblewrap could not materialize a deny target inside it as
      // the worker uid. Every party that recomputes this projection must pass the same value.
      acceptanceStorePath: trainingSlotPaths(registration.slot).state,
      denyPaths: registration.denyPaths,
      seccompProfileSha256: declaration.seccompProfileSha256,
      profileSha256: registration.profileSha256
    }) as unknown as Record<string, unknown>;
  const clock = DAIMON_GROK_ENGINE_BROKER.worker.taskClock;
  const expectedClock = { ...clock, directoryPath: clock.slotDirectoryPattern.replace("{slot}", String(registration.slot)),
    timestampFilePath: clock.slotFilePattern.replace("{slot}", String(registration.slot)) };
  const actualClock = projection.taskClock as Record<string, unknown> | undefined;
  if (registration.configVariant !== "clocked" || projection.version !== DAIMON_GROK_ENGINE_BROKER.projectionVersion
    || projection.profileSha256 !== registration.profileSha256 || actualClock === undefined
    || Object.entries(expectedClock).some(([key, value]) => actualClock[key] !== value)
    || projection.workerConfigVariant !== "clocked" || projection.workerConfigSha256 !== registration.configSha256) {
    throw new SpawnfileError("runtime_error", "Daimon's clocked worker config differs from the provisioned registration");
  }
  const denied = [...(projection.denyPaths as string[])];
  if (denied.length !== registration.denyPaths.length || denied.some((entry, index) => entry !== registration.denyPaths[index])) {
    throw new SpawnfileError("runtime_error", "Daimon's Grok broker projection deny list differs from the provisioned sandbox profile");
  }
  return { projection, projectionSha256: daimon.grokBrokerProjectionSha256(projection) };
};
