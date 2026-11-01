import { agentManifest, dataFiles, example, training, target, trainingProject } from "./plan/fixtures.test-helper.js";

export const executionFixture = () => trainingProject({
  ...dataFiles,
  Spawnfile: agentManifest({ training: { ...training, targets: [{ ...target,
    datasets: { ...target.datasets, validation: "training/validation.yaml" } }] } }),
  "training/validation.yaml": { examples: [{ ...example, id: "validation" }] }
});
