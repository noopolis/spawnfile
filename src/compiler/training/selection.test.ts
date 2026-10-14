import { expect, it } from "vitest";
import { selectTrainingAgent } from "./selection.js";

const agents = [
  { id: "agent:writer", value: { name: "writer" } },
  { id: "agent:nested-writer", value: { name: "writer" } }
];
it("prefers exact IDs, rejects ambiguous short names, and lists the available exact IDs", () => {
  expect(selectTrainingAgent(agents, "agent:writer")).toBe(agents[0]);
  expect(() => selectTrainingAgent(agents, "writer"), "ambiguous selection guarantee").toThrow("Ambiguous training agent writer; use an exact node id: agent:nested-writer, agent:writer");
  expect(selectTrainingAgent(agents, "nested-writer")).toBe(agents[1]);
});
it("accepts one full authored name, without accepting prefixes or team IDs", () => {
  expect(selectTrainingAgent(agents.slice(0, 1), "writer")).toBe(agents[0]);
  expect(selectTrainingAgent(agents.slice(0, 1), undefined)).toBe(agents[0]);
  for (const selector of [undefined, "writ", "team:writer", "agent:unknown"]) {
    expect(() => selectTrainingAgent(agents, selector)).toThrow(/--agent|No canonical agent/u);
  }
});
