import { agentManifest, dataFiles, example, training, target, trainingProject } from "./plan/fixtures.test-helper.js";

export const executionImage = `sha256:${"a".repeat(64)}`;
export const executionFixture = () => trainingProject({
  ...dataFiles,
  Spawnfile: agentManifest({ training: { ...training, targets: [{ ...target,
    datasets: { ...target.datasets, validation: "training/validation.yaml" } }] } }),
  "training/validation.yaml": { examples: [{ ...example, id: "validation" }] },
  "training/settings.json": "{}",
  "training/container.json": JSON.stringify({
    version: "spawnfile.training-container.v2", dockerContext: "local", image: { ref: executionImage },
    inputs: [{ id: "project", source: "..", destination: "/run/training/inputs/project",
      include: ["Spawnfile", "AGENTS.md", "training"] }],
    integration: { settings: { input: "project", path: "training/settings.json" } },
    output: { source: "unused-output-template", destination: "/run/training/output" }, auth: []
  })
});
