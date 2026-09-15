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
  const selection = (files: typeof old, prefix: string, excludes: string[] = []) => {
    const values = files.filter(file => file.destination.startsWith(prefix) && !excludes.some(value => file.destination === value || (value.endsWith("/") && file.destination.startsWith(value))))
      .map(file => ({ ...file, destination: file.destination.slice(prefix.length) })).sort((a, b) => a.destination.localeCompare(b.destination));
    if (!values.length) throw Error(`Repair lacks compatibility evidence for ${prefix}`);
    return hashJson(values);
  };
  const components: Record<string, string> = {};
  const compare = (name: string, previous: string, updated: string) => {
    if (previous !== updated) throw Error(`Repair subject compatibility changed: ${name}`);
    components[name] = updated;
  };
  for (const field of ["nativeImage", "pythonImage", "platform"] as const) compare(field,
    hashJson(witness.image.build[field]), hashJson(current.build[field]));
  compare("compiler", selection(old, witness.image.build.compiler ? "compiler/" : "spawnfile/"), selection(next, "compiler/"));
  for (const [name, prefix] of Object.entries({ integration: "integration/", native: "paideia/dist/src/adapters/daimon-native/",
    trials: "paideia/dist/src/experiments/trials/" })) compare(name, selection(old, prefix), selection(next, prefix));
  const excluded = ["bridge/paideia_dspy/checkpoint.py", "bridge/paideia_dspy/protocol.py", "bridge/README.md", "bridge/protocol.md", "bridge/.coverage", "bridge/.pytest_cache/", "bridge/coverage.json"];
  compare("optimizer", selection(old, "bridge/", excluded), selection(next, "bridge/", excluded));
  const previousInputs = witness.inputs.map(input => ({ id: input.id, destination: input.destination, digest: input.digest }));
  const currentInputs = inputs.map(input => ({ id: input.id, destination: input.destination, digest: input.digest }));
  if (hashJson(previousInputs) !== hashJson(currentInputs)) throw Error("Repair evidence or dataset inputs changed");
  return { components, inputs: Object.fromEntries(currentInputs.map(input => [input.id, input.digest])) };
}
