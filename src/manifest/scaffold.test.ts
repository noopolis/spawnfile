import { describe, expect, it } from "vitest";

import { createAgentScaffoldManifest, createTeamScaffoldManifest } from "./scaffold.js";

describe("createAgentScaffoldManifest", () => {
  it("builds an agent scaffold manifest without auth by default", () => {
    expect(
      createAgentScaffoldManifest({
        docs: {
          identity: "IDENTITY.md",
          soul: "SOUL.md",
          system: "AGENTS.md"
        },
        modelName: "claude-opus-4-6",
        provider: "anthropic",
        runtime: "openclaw"
      })
    ).toMatchObject({
      docs: {
        identity: "IDENTITY.md",
        soul: "SOUL.md",
        system: "AGENTS.md"
      },
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      runtime: "openclaw"
    });
    const scaffold = createAgentScaffoldManifest({
      docs: {
        identity: "IDENTITY.md",
        soul: "SOUL.md",
        system: "AGENTS.md"
      },
      modelName: "claude-opus-4-6",
      provider: "anthropic",
      runtime: "openclaw"
    });
    expect(scaffold.execution?.model?.auth).toBe(undefined);
    expect(scaffold.execution?.workspace).toBe(undefined);
    expect(scaffold.execution?.sandbox).toBe(undefined);
  });

  it("switches provider defaults when claude-code auth is selected", () => {
    expect(
      createAgentScaffoldManifest({
        authMethod: "claude-code",
        docs: {
          soul: "SOUL.md",
          system: "AGENTS.md"
        },
        modelName: "claude-sonnet-4-6",
        provider: "anthropic",
        runtime: "tinyclaw"
      })
    ).toMatchObject({
      execution: {
        model: {
          auth: {
            method: "claude-code"
          },
          primary: {
            name: "claude-sonnet-4-6",
            provider: "anthropic"
          }
        }
      }
    });
  });
});

describe("createTeamScaffoldManifest", () => {
  it("builds the default team scaffold manifest", () => {
    expect(createTeamScaffoldManifest()).toMatchObject({
      docs: {
        system: "TEAM.md"
      },
      kind: "team",
      members: [],
      structure: {
        mode: "swarm"
      }
    });
  });
});
