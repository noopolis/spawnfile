import { describe, expect, it } from "vitest";

import type { OrganizationView } from "../compiler/index.js";
import { resolveStatusSelector } from "./selectors.js";

const createView = (): OrganizationView => ({
  contexts: [],
  diagnostics: [],
  inputPath: "/project",
  networks: [
    {
      declaringTeamName: "root",
      declaringTeamSource: "/project/Spawnfile",
      id: "local_lab",
      name: "Local Lab",
      provider: "moltnet",
      rooms: []
    }
  ],
  projectRoot: "/project",
  root: {
    children: [
      {
        label: "first",
        node: {
          children: [],
          displayName: "worker [agent:worker]",
          id: "agent:worker",
          kind: "agent",
          name: "worker",
          runtimeName: "openclaw",
          slug: "worker",
          source: "/project/agents/first/Spawnfile"
        },
        relation: "team_member"
      },
      {
        label: "second",
        node: {
          children: [],
          displayName: "worker [agent:worker#22222222]",
          id: "agent:worker#22222222",
          kind: "agent",
          name: "worker",
          runtimeName: "openclaw",
          slug: "worker-2",
          source: "/project/agents/second/Spawnfile"
        },
        relation: "team_member"
      }
    ],
    displayName: "root",
    id: "team:root",
    kind: "team",
    name: "root",
    runtimeName: null,
    slug: "root",
    source: "/project/Spawnfile"
  },
  runtimes: [{ name: "openclaw", nodeIds: ["agent:worker", "agent:worker#22222222"] }]
});

describe("status selectors", () => {
  it("resolves exact ids before duplicate names", () => {
    expect(resolveStatusSelector(createView(), {
      kind: "agent",
      value: "agent:worker#22222222"
    })).toMatchObject({
      kind: "selected",
      selection: { subjectKeys: ["agent:worker#22222222"] }
    });
  });

  it("resolves network and runtime selectors", () => {
    expect(resolveStatusSelector(createView(), {
      kind: "network",
      value: "local_lab"
    })).toMatchObject({
      kind: "selected",
      selection: { subjectKeys: ["network:local_lab"] }
    });
    expect(resolveStatusSelector(createView(), {
      kind: "runtime",
      value: "openclaw"
    })).toMatchObject({
      kind: "selected",
      selection: { subjectKeys: ["runtime:openclaw", "agent:worker", "agent:worker#22222222"] }
    });
  });

  it("resolves unique names and slugs", () => {
    expect(resolveStatusSelector(createView(), { kind: "team", value: "root" }))
      .toMatchObject({
        kind: "selected",
        selection: { subjectKeys: ["team:root"] }
      });
    expect(resolveStatusSelector(createView(), { kind: "agent", value: "worker-2" }))
      .toMatchObject({
        kind: "selected",
        selection: { subjectKeys: ["agent:worker#22222222"] }
      });
    expect(resolveStatusSelector(createView(), { kind: "network", value: "Local Lab" }))
      .toMatchObject({
        kind: "selected",
        selection: { subjectKeys: ["network:local_lab"] }
      });
  });

  it("reports ambiguous and unknown selectors as input failures", () => {
    expect(resolveStatusSelector(createView(), { kind: "agent", value: "worker" }))
      .toMatchObject({ failure: { exitCode: 2, message: expect.stringContaining("Ambiguous") } });
    expect(resolveStatusSelector(createView(), { kind: "team", value: "missing" }))
      .toMatchObject({ failure: { exitCode: 2, message: expect.stringContaining("Unknown") } });
    expect(resolveStatusSelector(createView(), { kind: "network", value: "missing" }))
      .toMatchObject({ failure: { exitCode: 2, message: expect.stringContaining("Unknown") } });
    expect(resolveStatusSelector(createView(), { kind: "runtime", value: "missing" }))
      .toMatchObject({ failure: { exitCode: 2, message: expect.stringContaining("Unknown") } });
  });
});
