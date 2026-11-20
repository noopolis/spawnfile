import { expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import { hermesSubagentDiagnostic } from "./subagents.js";

it("reports why native profiles cannot give a declared Hermes helper its own tool scope", () => {
  const parent: ResolvedAgentNode = {
    kind: "agent", name: "Pilot", source: "pilot", description: "", env: {}, policyMode: null, policyOnDegrade: null,
    runtime: { name: "hermes-agent", options: {} }, docs: [], skills: [], secrets: [], mcpServers: [],
    subagents: [{ id: "review", nodeSource: "reviewer" }], execution: undefined
  };
  expect(hermesSubagentDiagnostic(parent)).toContain("inherits the parent's tools");
  expect(hermesSubagentDiagnostic({ ...parent, subagents: [] })).toBeUndefined();
});
