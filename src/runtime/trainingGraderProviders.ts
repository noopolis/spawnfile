import { createClaudeInference } from "../training/index.js";
import type { GraderProviderRegistry } from "../training/contracts/index.js";
import { EMPTY_TOOLS_TEACHER_POLICY } from "../shared/trainingLegacy/index.js";
import { SpawnfileError } from "../shared/errors.js";
import type { RuntimeTrainingGraderContribution } from "./trainingProviderTypes.js";

const unavailableCouncil = (): never => {
  throw new SpawnfileError("validation_error", "No installed runtime provides a training grader council");
};

export const assembleTrainingGraders = (
  contributions: readonly { name: string; contribution: RuntimeTrainingGraderContribution }[]
): GraderProviderRegistry => {
  const providers: GraderProviderRegistry["providers"][number][] = [{
    id: "claude", inferenceProviderId: "claude-subscription", decisionTools: "disabled",
    teacherPolicy: EMPTY_TOOLS_TEACHER_POLICY, decompositionExtractor: true, atomicExtractor: false,
    validateAtomicConfig(teacher) {
      if (teacher.effort !== undefined && !["low", "medium", "high", "xhigh"].includes(teacher.effort)) {
        throw new Error("Unsupported extractor effort");
      }
    },
    create(teacher, timeoutMs) {
      if (teacher.effort !== undefined) throw new Error("Claude teacher effort is unsupported");
      return createClaudeInference({ timeoutMs });
    }
  }];
  let council: GraderProviderRegistry["council"] | undefined;
  for (const { name, contribution } of contributions) {
    if (contribution.council && council) {
      throw new SpawnfileError("validation_error", `Multiple runtimes claim the training grader council at ${name}`);
    }
    council = contribution.council ?? council;
    providers.push(...contribution.providers);
  }
  return {
    providers,
    council: council ?? {
      requiredProviders: [], requiredMessage: "No installed runtime provides a training grader council",
      defaultWindow: { start: "00:00", end: "00:00" }, limitedProvider: "",
      windowOpen: unavailableCouncil, outsideWindow: unavailableCouncil, closedWindow: unavailableCouncil,
      extractorMessage: "No installed runtime provides a training grader council"
    }
  };
};
