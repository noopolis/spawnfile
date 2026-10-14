import path from "node:path";
import { expect, it } from "vitest";
import { defaultTrainingOutputRoot } from "./output.js";
import { within } from "./preparation/files.js";

it("places default output and its preparation siblings outside every input including project ancestors", () => {
  const project = "/sandbox/public/project", inputs = ["/sandbox/public", "/sandbox/.spawn-training", "/sandbox/private"];
  const output = defaultTrainingOutputRoot(project, inputs);
  for (const input of [project, ...inputs]) {
    expect(within(input, output) || within(output, input), "disjoint default output guarantee").toBe(false);
  }
  expect(output, "disjoint default output guarantee").toMatch(/^\/\.spawn-training\/project-/u);
  expect(defaultTrainingOutputRoot(project, inputs)).toBe(output);
  expect(defaultTrainingOutputRoot(path.join(project, "other"), inputs)).not.toBe(output);
});
it("refuses an input covering the filesystem root rather than allocating inside it", () => {
  expect(() => defaultTrainingOutputRoot("/project", ["/"]), "disjoint default output guarantee").toThrow("supply --out");
});
