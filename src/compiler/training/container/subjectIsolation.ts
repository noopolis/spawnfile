import { getDaimonEngineDescriptor } from "../../../runtime/daimon/index.js";
import { resolveDaimonEngine } from "../../../runtime/daimon/config.js";
import { resolveTrainingContextGraph } from "../context.js";
import { trainingContextSchema, type TrainingContext } from "../contract.js";

/** Resolve host-side subject policy; the public v1 context carries no sandbox authority. */
export const assertTrainingSubjectIsolation = async (
  config: { subjectIsolation?: "codex-native-sandbox" }, context: TrainingContext
): Promise<void> => {
  if (config.subjectIsolation !== "codex-native-sandbox") return;
  const parsed = trainingContextSchema.parse(context);
  const { selected } = await resolveTrainingContextGraph(parsed.project.manifest, parsed.agent.id);
  const agent = selected.value;
  if (agent.runtime.name !== "daimon" || getDaimonEngineDescriptor(resolveDaimonEngine(agent))?.training.subject.isolation !== "native-sandbox" ||
    agent.runtime.options.codex_policy !== "workspace-no-network" || agent.execution?.sandbox?.mode !== "workspace") {
    throw Error("codex-native-sandbox subject isolation requires the selected training agent to use runtime daimon, engine codex, and strict codex_policy: workspace-no-network (execution.sandbox.mode: workspace)");
  }
};
