import { hasLegacyTrainingDistribution } from '../../../shared/index.js';
import type { TrainingContext } from "../contract.js";
import type { TrainingImagePlan } from "../preparation/image.js";
import type { PlannedInput } from "../preparation/inputs.js";
import { fileIdentity, hashJson } from "../preparation/files.js";
import type { TrainingWitness } from "./contract.js";

/** Subject and optimizer semantics remain pinned; only evaluation/fork plumbing may change. */
export function verifyTrainingCompatibility(witness: TrainingWitness, current: TrainingImagePlan,
  inputs: PlannedInput[], context: TrainingContext) {
  if (context.agent.runtime !== "daimon" || context.project.sourceDigest !== witness.context.project.sourceDigest ||
    JSON.stringify(context.agent) !== JSON.stringify(witness.context.agent)) throw Error("Repair canonical agent changed");
  const old = witness.image.files, next = fileIdentity(current.files);
  if (hasLegacyTrainingDistribution(witness.image)) {
    throw Error("Repair references an external training distribution; re-prepare with Spawnfile before repairing measurements");
  }
  const selection = (files: typeof old, prefix: string, excludes: string[] = []) => {
    const values = files.filter(file => file.destination.startsWith(prefix) && !excludes.some(value => file.destination === value || (value.endsWith("/") && file.destination.startsWith(value))))
      .map(file => ({ ...file, destination: file.destination.slice(prefix.length) })).sort((a, b) => a.destination.localeCompare(b.destination));
    if (!values.length) throw Error(`Repair lacks compatibility evidence for ${prefix}`);
    return hashJson(values);
  };
  const components: Record<string, string> = {};
  const compare = (name: string, previous: string, updated: string) => {
    if (previous !== updated) throw Error(`Repair subject compatibility changed: ${name}; re-prepare with Spawnfile before repairing measurements`);
    components[name] = updated;
  };
  for (const field of ["nativeImage", "pythonImage", "platform"] as const) compare(field,
    hashJson(witness.image.build[field]), hashJson(current.build[field]));
  // The compiler closure excludes the training implementation so repair may update
  // evaluator/fork transport while preserving subject and optimizer semantics below.
  const compilerExclusions = ["compiler/dist/training/", "compiler/dist/runtime/trainingCli.js",
    "compiler/dist/runtime/trainingCli.d.ts", "compiler/dist/runtime/trainingSubjects.js",
    "compiler/dist/runtime/trainingSubjects.d.ts", "compiler/dist/runtime/daimon/training/", "compiler/dist/runtime/codex-exec/training/"];
  compare("compiler", selection(old, "compiler/", compilerExclusions), selection(next, "compiler/", compilerExclusions));
  for (const [name, prefix] of Object.entries({ integration: "integration/", "training-native": "spawnfile/dist/runtime/daimon/training/",
    "training-trials": "spawnfile/dist/training/experiments/trials/" })) compare(name, selection(old, prefix), selection(next, prefix));
  const bridge = "spawnfile/dist/training/dspy/";
  const excluded = ["spawnfile_training_dspy/checkpoint.py", "spawnfile_training_dspy/protocol.py", "README.md", "protocol.md", ".coverage", ".pytest_cache/", "coverage.json"]
    .map(file => bridge + file);
  compare("training-optimizer", selection(old, bridge, excluded), selection(next, bridge, excluded));
  const previousInputs = witness.inputs.map(input => ({ id: input.id, destination: input.destination, digest: input.digest }));
  const currentInputs = inputs.map(input => ({ id: input.id, destination: input.destination, digest: input.digest }));
  if (hashJson(previousInputs) !== hashJson(currentInputs)) throw Error("Repair evidence or dataset inputs changed");
  return { components, inputs: Object.fromEntries(currentInputs.map(input => [input.id, input.digest])) };
}
