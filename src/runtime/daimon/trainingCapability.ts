import type { RuntimeTrainingCapability } from "../trainingTypes.js";
import { daimonTrainingDeclaration, getDaimonEngineDescriptor } from "./engines.js";

export const daimonTraining: RuntimeTrainingCapability = {
  ...daimonTrainingDeclaration,
  subject: async () => (await import("./training/index.js")).daimonTrainingSubject,
  run: async (options) => (await import("./training/trial/runTraining.js")).runDaimonTraining(options),
  openJudges: async (options) => (await import("./training/trial/run.js")).openTrainingRun({ ...options, scratch: "booted-judges" }),
  login: {
    supportsEngine: (engine) => getDaimonEngineDescriptor(engine)?.auth.staging === "secret-service",
    run: async (options) => (await import("./training/trial/index.js")).loginSubscriptionRealm(options)
  },
  loadInferenceProviders: async () => (await import("./training/inferenceProviders.js")).daimonTrainingInferenceProviders(),
  loadGraderProviders: async () => (await import("./training/graderProviders.js")).daimonTrainingGraderProviders,
  credentials: {
    codex: async () => {
      const { prepareTrainingCodexAuthority, verifyTrainingCodexBootstrap } =
        await import("./training/trial/trainingCodexAuthority.js");
      return { prepareAuthority: prepareTrainingCodexAuthority, stage: verifyTrainingCodexBootstrap };
    },
    grok: async () => {
      const { writeBackTrainingGrokCredential } = await import("./training/trial/trainingGrokWriteback.js");
      return { writeBack: writeBackTrainingGrokCredential };
    }
  }
};
