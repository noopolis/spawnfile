import { describe, expect, it } from "vitest";

import { editableComponentKey, lowerBoundaries } from "./boundaries.js";
import type { TrainingPlan } from "./plan/index.js";

const plan = { targets: [{ files: [{ path: "agents/tinkerton/AGENTS.md" }] }] } as unknown as TrainingPlan;

describe("lowerBoundaries", () => {
  it("names the training CLI's component key for a declared editable file", () => {
    expect(editableComponentKey("agents/tinkerton/AGENTS.md")).toBe("resource-dd3f3db0bbbce0b5#file");
    expect(lowerBoundaries(plan, ['max-bytes ["AGENTS.md", "14000"]', 'require-text ["agents/tinkerton/AGENTS.md", "## How I write"]']))
      .toEqual(['max-bytes ["resource-dd3f3db0bbbce0b5#file","14000"]', 'require-text ["resource-dd3f3db0bbbce0b5#file","## How I write"]']);
  });

  it("refuses a boundary that is not an operation with arguments or names no editable file", () => {
    expect(() => lowerBoundaries(plan, ["Keep it short."])).toThrow(/not an operation/u);
    expect(() => lowerBoundaries(plan, ['max-bytes ["AGENTS.md", 1'])).toThrow(/not an operation/u);
    expect(() => lowerBoundaries(plan, ["preserve [1]"])).toThrow(/not an operation/u);
    expect(() => lowerBoundaries(plan, ['preserve ["SOUL.md"]'])).toThrow(/no editable target file: SOUL.md/u);
  });
});
