import { describe, expect, it } from "vitest";

import {
  mergeWorkspaceResourcePlans,
  mergeWorkspaceResources
} from "./workspaceResources.js";

const agentScope = {
  kind: "agent" as const,
  key: "/tmp/agents/worker/Spawnfile",
  name: "worker"
};

describe("workspaceResources", () => {
  it("normalizes workspace mounts and creates per-target backing plans", () => {
    const resources = mergeWorkspaceResources(
      [],
      [
        {
          id: "project",
          kind: "git",
          mode: "mutable",
          mount: "${workspace}/repos/project/",
          ref: "abc123",
          url: "https://example.com/project.git"
        }
      ],
      "worker",
      agentScope
    );

    expect(resources[0]).toMatchObject({
      id: "project",
      mount: "./repos/project",
      sharing: "per_agent"
    });

    const [plan] = mergeWorkspaceResourcePlans(resources, "target", {
      targetId: "agent-worker",
      workspacePath: "/workspace"
    });

    expect(plan).toMatchObject({
      backingPath: expect.stringContaining("/var/lib/spawnfile/resources/instances/agent-worker-"),
      linkPath: "/workspace/repos/project",
      mount: "./repos/project",
      ref: "abc123",
      sharing: "per_agent"
    });
  });

  it("keeps absolute mounts as link paths and scopes team-shared volume backing", () => {
    const resources = mergeWorkspaceResources(
      [],
      [
        {
          id: "dropbox",
          kind: "volume",
          mode: "mutable",
          mount: "/shared/dropbox",
          name: "team-dropbox",
          sharing: "team"
        }
      ],
      "lab",
      {
        kind: "team",
        key: "/tmp/lab/Spawnfile",
        name: "lab"
      }
    );
    const [plan] = mergeWorkspaceResourcePlans(resources, "target", {
      targetId: "agent-worker",
      workspacePath: "/workspace"
    });

    expect(plan).toMatchObject({
      backingPath: expect.stringContaining("/var/lib/spawnfile/resources/teams/team-lab-"),
      linkPath: "/shared/dropbox",
      mount: "/shared/dropbox",
      name: "team-dropbox",
      sharing: "team"
    });
  });

  it("compares bundle build roots and sources resolved against their declaring manifest", () => {
    const teamScope = { kind: "team" as const, key: "/tmp/team/Spawnfile", name: "team" };
    const bundle = { build: { files: { root: "./tools" } }, id: "tools", kind: "bundle" as const, mode: "readonly" as const, mount: "./tools" };
    const inherited = mergeWorkspaceResources([], [bundle], "team", teamScope);
    expect(() => mergeWorkspaceResources(inherited, [bundle], "worker", agentScope)).toThrow(/resolves differently/u);
    expect(mergeWorkspaceResources(inherited, [{ ...bundle, build: { files: { root: "../../team/tools" } } }], "worker", agentScope)).toHaveLength(1);
    const prebuilt = { id: "tools", kind: "bundle" as const, mode: "readonly" as const, mount: "./tools", source: "./tools.tar" };
    expect(() => mergeWorkspaceResources(mergeWorkspaceResources([], [prebuilt], "team", teamScope), [prebuilt], "worker", agentScope)).toThrow(/resolves differently/u);
  });

  it("dedupes identical resource IDs and rejects conflicting duplicates", () => {
    const identical = mergeWorkspaceResources(
      [],
      [
        {
          id: "cache",
          kind: "volume",
          mode: "mutable",
          mount: "./cache"
        },
        {
          id: "cache",
          kind: "volume",
          mode: "mutable",
          mount: "${workspace}/cache"
        }
      ],
      "worker",
      agentScope
    );

    expect(identical).toHaveLength(1);

    expect(() =>
      mergeWorkspaceResources(
        [],
        [
          {
            id: "cache",
            kind: "volume",
            mode: "mutable",
            mount: "./cache"
          },
          {
            id: "cache",
            kind: "volume",
            mode: "readonly",
            mount: "./cache"
          }
        ],
        "worker",
        agentScope
      )
    ).toThrow(/resolves differently/);
  });
});
