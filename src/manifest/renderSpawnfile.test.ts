import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { renderSpawnfile } from "./renderSpawnfile.js";
import { createAgentScaffoldManifest } from "./scaffold.js";
import { manifestSchema } from "./schemas.js";

describe("renderSpawnfile", () => {
  it("renders a valid agent manifest as YAML", () => {
    const source = renderSpawnfile({
      docs: {
        system: "AGENTS.md"
      },
      execution: {
        model: {
          auth: {
            method: "api_key"
          },
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        },
        sandbox: {
          mode: "workspace"
        },
        workspace: {
          isolation: "isolated"
        }
      },
      kind: "agent",
      name: "my-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(source).toContain("runtime: openclaw");
    expect(
      manifestSchema.parse(YAML.parse(source) as unknown)
    ).toMatchObject({
      kind: "agent",
      runtime: "openclaw"
    });
  });

  it("renders scaffold manifests in canonical top-level order", () => {
    const source = renderSpawnfile(
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
    );

    const spawnfileVersionIndex = source.indexOf("spawnfile_version:");
    const kindIndex = source.indexOf("kind: agent");
    const nameIndex = source.indexOf("name: my-agent");
    const runtimeIndex = source.indexOf("runtime: openclaw");
    const executionIndex = source.indexOf("execution:");
    const docsIndex = source.indexOf("docs:");

    expect(spawnfileVersionIndex).toBeGreaterThanOrEqual(0);
    expect(kindIndex).toBeGreaterThan(spawnfileVersionIndex);
    expect(nameIndex).toBeGreaterThan(kindIndex);
    expect(runtimeIndex).toBeGreaterThan(nameIndex);
    expect(executionIndex).toBeGreaterThan(runtimeIndex);
    expect(docsIndex).toBeGreaterThan(executionIndex);
    expect(source).toContain("      name: claude-opus-4-6");
    expect(source).toContain("      provider: anthropic");
    expect(source).not.toContain("  workspace:");
    expect(source).not.toContain("  sandbox:");
    expect(source).toContain("  identity: IDENTITY.md");
    expect(source).toContain("  soul: SOUL.md");
    expect(source).toContain("  system: AGENTS.md");
    expect(source).toContain('name: my-agent\n\nruntime: openclaw\n\nexecution:');
    expect(source).toContain("provider: anthropic\n\ndocs:");
  });

  it("renders rewritten agent manifests with subagents in canonical order", () => {
    const source = renderSpawnfile({
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
      kind: "agent",
      name: "my-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      subagents: [
        {
          id: "pepito",
          ref: "./subagents/pepito"
        }
      ]
    });

    const spawnfileVersionIndex = source.indexOf("spawnfile_version:");
    const kindIndex = source.indexOf("kind: agent");
    const nameIndex = source.indexOf("name: my-agent");
    const runtimeIndex = source.indexOf("runtime: openclaw");
    const executionIndex = source.indexOf("execution:");
    const docsIndex = source.indexOf("docs:");
    const subagentsIndex = source.indexOf("subagents:");

    expect(spawnfileVersionIndex).toBeGreaterThanOrEqual(0);
    expect(kindIndex).toBeGreaterThan(spawnfileVersionIndex);
    expect(nameIndex).toBeGreaterThan(kindIndex);
    expect(runtimeIndex).toBeGreaterThan(nameIndex);
    expect(executionIndex).toBeGreaterThan(runtimeIndex);
    expect(docsIndex).toBeGreaterThan(executionIndex);
    expect(subagentsIndex).toBeGreaterThan(docsIndex);
    expect(source).toContain("name: my-agent\n\nruntime: openclaw\n\nexecution:");
    expect(source).toContain("docs:\n  identity: IDENTITY.md");
    expect(source).toContain("system: AGENTS.md\n\nsubagents:");
  });
});
