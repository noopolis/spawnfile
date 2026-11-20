import type { InferenceProviderDescriptor } from "./trainingTypes.js";
import { requireAuthProfile } from "../auth/index.js";
import { TRAINING_MOMENT_PROFILE } from "../compiler/training/index.js";
import { momentPreparation } from "../compiler/training/trial/index.js";
import { SpawnfileError } from "../shared/index.js";
import { bootNativeTrainingTrial } from "./nativeTrainingContainer.js";
import { createNativeTrainingSubject } from "./nativeTrainingSubject.js";
import type { NativeTrainingDriver } from "./nativeTraining.js";
import { invokeTrainingCore } from "./trainingCoreInvoker.js";
import { composeTrainingInference, type TrainingInferenceComposition } from "./trainingComposition.js";
import type { RuntimeTrainingRunOptions } from "./trainingTypes.js";

export async function runNativeTraining(runtime: string, driver: NativeTrainingDriver, options: RuntimeTrainingRunOptions): Promise<number> {
  const { context, args } = options;
  const instructions = context.documents.find(document => document.role === "system");
  if (context.agent.runtime !== runtime || !instructions) {
    throw new SpawnfileError("validation_error", `Training requires the selected ${runtime} agent and its system instructions`);
  }
  const profile = options.authProfile ? await requireAuthProfile(options.authProfile) : null;
  const registration = { create: ({ timeoutMs }: { timeoutMs: number }) =>
    createNativeTrainingSubject(runtime, driver, timeoutMs, input =>
      bootNativeTrainingTrial(context, profile, input, undefined, driver.serviceEnvironment)) };
  const outIndex = args.indexOf("--out");
  const out = outIndex < 0 ? undefined : args[outIndex + 1];
  if (!out) throw new SpawnfileError("validation_error", "Training requires --out");
  const judges = nativeTrainingJudges(await composeTrainingInference(), options, out);
  try {
    return await invokeTrainingCore(["train", ...args, "--runtime", runtime, "--model", context.agent.model?.name ?? runtime,
      "--source-root", context.project.root, "--instructions", instructions.destinationPath], {
      cwd: process.cwd(), signal: options.signal, stdout: options.streams.stdout, stderr: options.streams.stderr
    }, { subjects: { [runtime]: registration }, inferenceProviders: judges.registry, preparations: { [TRAINING_MOMENT_PROFILE]: momentPreparation },
      unlockedSetupPaths: ["moment"], prepareEnvironment: async () => ({}) });
  } finally { await judges.close(); }
}

/** A judge or optimizer can run on a different harness. Open its host only on an actual inference call. */
export function nativeTrainingJudges(
  composition: TrainingInferenceComposition,
  options: Pick<RuntimeTrainingRunOptions, "authProfile" | "controls" | "signal" | "streams">, out: string
) {
  const hosts = new Map<string, Promise<{ close(): Promise<void> }>>();
  const providers: Record<string, InferenceProviderDescriptor> = {};
  for (const [id, descriptor] of Object.entries(composition.registry.providers)) {
    const owner = composition.owners.get(id);
    const training = owner?.training;
    const open = training?.openJudges?.bind(training);
    if (!owner || !open) {
      providers[id] = descriptor;
      continue;
    }
    providers[id] = {
      ...descriptor,
      create(model, context) {
        const provider = descriptor.create(model, context);
        return { ...provider, async generate(request) {
          if (!options.authProfile) throw new SpawnfileError("validation_error", `Inference provider ${id} requires --auth-profile`);
          request.signal?.throwIfAborted();
          let ready = hosts.get(owner.name);
          if (!ready) {
            ready = open({ ...options.controls, authProfile: options.authProfile, out, streams: options.streams, signal: options.signal });
            hosts.set(owner.name, ready);
          }
          await ready;
          return provider.generate(request);
        } };
      }
    };
  }
  return { registry: { ...composition.registry, providers }, async close() {
    // A failed opener owns its own rollback. Every successfully opened host still closes.
    const opened = await Promise.allSettled(hosts.values());
    const closed = await Promise.allSettled(opened.flatMap(result => result.status === "fulfilled" ? [result.value.close()] : []));
    const failed = closed.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } };
}
