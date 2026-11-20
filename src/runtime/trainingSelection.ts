import { SpawnfileError } from "../shared/index.js";
import type {
  RuntimeTrainingCapability, RuntimeTrainingLoginOptions, RuntimeTrainingLoginResult, TrainingCredentialOperations
} from "./trainingTypes.js";

export interface RuntimeTrainingRegistration {
  name: string;
  training?: RuntimeTrainingCapability;
}

export const runtimeTrainingRegistrations = async (): Promise<readonly RuntimeTrainingRegistration[]> =>
  (await import("./registry.js")).loadRuntimeRegistry();

export const requireLiveTraining = async (runtime: string, agentId: string): Promise<NonNullable<RuntimeTrainingCapability["run"]>> => {
  const entry = (await runtimeTrainingRegistrations()).find(({ name }) => name === runtime);
  const training = entry?.training;
  if (!training?.run) {
    throw new SpawnfileError("validation_error", `Agent ${agentId} runs on ${runtime}, which has no live training capability`);
  }
  return training.run.bind(training);
};

export const loginSubscriptionRealm = async (
  { runtime, ...options }: RuntimeTrainingLoginOptions & { runtime?: string }
): Promise<RuntimeTrainingLoginResult> => {
  const entries = await runtimeTrainingRegistrations();
  const eligible = entries.filter(({ name, training }) =>
    (runtime === undefined || runtime === name) && training?.login?.supportsEngine(options.engine));
  if (!eligible.length) {
    const scope = runtime ? `Runtime ${runtime} engine ${options.engine}` : `Engine ${options.engine}`;
    throw new SpawnfileError("validation_error", `${scope} has no volume-held login; use \`spawnfile auth import ${options.engine}\``);
  }
  if (eligible.length > 1) {
    throw new SpawnfileError("validation_error",
      `Engine ${options.engine} matches multiple login runtimes (${eligible.map(({ name }) => name).join(", ")}); select --runtime`);
  }
  return eligible[0]!.training!.login!.run(options);
};

export const findTrainingCredentialOperations = async (provider: string): Promise<TrainingCredentialOperations | undefined> => {
  const entries = await runtimeTrainingRegistrations();
  const owners = entries.filter(({ training }) => training?.credentials && Object.hasOwn(training.credentials, provider));
  if (owners.length > 1) throw new SpawnfileError("validation_error", `Multiple training runtimes claim credential provider ${provider}`);
  return owners[0]?.training?.credentials?.[provider]?.();
};
