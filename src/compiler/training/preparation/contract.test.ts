import { expect, it } from "vitest";
import { parseTrainingMappedPreparation, trainingPreparationSchema } from "./contract.js";

const config = () => ({ version: "spawnfile.training-container.v2", dockerContext: "local", image: { ref: `sha256:${"a".repeat(64)}` },
  integration: { settings: { input: "project", path: "." } }, inputs: [{ id: "project", source: "project", destination: "/run/training/inputs/project" }],
  output: { source: "out", destination: "/run/training/output" }, auth: [] });
it("keeps authoring strict and rejects ambiguous input and settings references", () => {
  const base = config(); expect(trainingPreparationSchema.parse(base)).toEqual(base);
  expect(() => trainingPreparationSchema.parse({ ...base, inputs: [...base.inputs, ...base.inputs] })).toThrow("unique");
  expect(() => trainingPreparationSchema.parse({ ...base, auth: [{ source: "one", provider: "grok" }, { source: "two", provider: "grok" }] })).toThrow("unique");
  expect(() => trainingPreparationSchema.parse({ ...base, integration: { settings: { input: "missing", path: "settings.json" } } })).toThrow("declared");
  expect(() => trainingPreparationSchema.parse({ ...base, inputs: [{ ...base.inputs[0], include: ["x"], git: { revision: "a".repeat(40) } }] })).toThrow("separate");
  for (const bad of ["../escape", "/absolute", "a\\b", "a//b"]) expect(() => trainingPreparationSchema.parse({ ...base, inputs: [{ ...base.inputs[0], include: [bad] }] })).toThrow();
});
it("validates the public mapped receipt without accepting host paths or missing IDs", () => {
  const receipt = { version: "spawnfile.training-preparation.v1", preparationDigest: `sha256:${"a".repeat(64)}`, imageId: `sha256:${"b".repeat(64)}`,
    bindings: [{ inputId: "project", destination: "/run/training/inputs/project" }], outputRoot: "/run/training/output",
    packagePaths: Object.fromEntries(["spawnfile", "paideia", "bridge", "nativeWorker", "integration", "bootstrap"].map(key => [key, `/opt/training/${key}`])),
    integration: { settings: { input: "project", path: "." } } };
  expect(parseTrainingMappedPreparation(receipt)).toEqual(receipt);
  expect(() => parseTrainingMappedPreparation({ ...receipt, bindings: [...receipt.bindings, ...receipt.bindings] })).toThrow("IDs");
  expect(() => parseTrainingMappedPreparation({ ...receipt, integration: { settings: { input: "absent", path: "." } } })).toThrow("IDs");
  expect(() => parseTrainingMappedPreparation({ ...receipt, packagePaths: { ...receipt.packagePaths, bridge: "/Users/operator/.config" } })).toThrow();
});
