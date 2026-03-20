import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { isTeamManifest } from "./schemas.js";
import { loadManifest, mergeExecution, normalizeRuntimeBinding } from "./loadManifest.js";

const fixturesRoot = path.resolve(process.cwd(), "fixtures");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("loadManifest", () => {
  it("loads a valid agent manifest", async () => {
    const manifestPath = path.join(fixturesRoot, "single-agent", "Spawnfile");
    const result = await loadManifest(manifestPath);

    expect(result.manifest.kind).toBe("agent");
    expect(result.manifest.name).toBe("analyst");
  });

  it("loads a valid team manifest", async () => {
    const manifestPath = path.join(fixturesRoot, "multi-runtime-team", "Spawnfile");
    const result = await loadManifest(manifestPath);

    expect(isTeamManifest(result.manifest)).toBe(true);
    if (!isTeamManifest(result.manifest)) {
      throw new Error("Expected team manifest");
    }

    expect(result.manifest.members).toHaveLength(3);
  });

  it("rejects missing documents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-invalid-doc-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: broken", "", "runtime: openclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );

    await expect(loadManifest(path.join(directory, "Spawnfile"))).rejects.toThrow(/Document not found/);
  });

  it("rejects skills that require undeclared MCP servers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-invalid-skill-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "skills", "web_search"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Instructions\n");
    await writeUtf8File(
      path.join(directory, "skills", "web_search", "SKILL.md"),
      ['---', "name: web_search", 'description: "Search"', "---", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: broken",
        "",
        "runtime: openclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        "",
        "skills:",
        "  - ref: ./skills/web_search",
        "    requires:",
        "      mcp:",
        "        - missing",
        ""
      ].join("\n")
    );

    await expect(loadManifest(path.join(directory, "Spawnfile"))).rejects.toThrow(/undeclared MCP/);
  });

  it("rejects missing SKILL.md files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-missing-skill-file-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Instructions\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: broken",
        "",
        "runtime: openclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        "",
        "skills:",
        "  - ref: ./skills/missing",
        ""
      ].join("\n")
    );

    await expect(loadManifest(path.join(directory, "Spawnfile"))).rejects.toThrow(
      /missing SKILL\.md/
    );
  });

  it("rejects duplicate team member ids", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-duplicate-members-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: broken-team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: analyst",
        "    ref: ./agents/a",
        "  - id: analyst",
        "    ref: ./agents/b",
        "",
        "structure:",
        "  mode: swarm",
        ""
      ].join("\n")
    );

    await expect(loadManifest(path.join(directory, "Spawnfile"))).rejects.toThrow(
      /Duplicate member id/
    );
  });

  it("rejects leader that references undeclared member", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bad-structure-leader-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: broken-team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: analyst",
        "    ref: ./agents/a",
        "",
        "structure:",
        "  mode: hierarchical",
        "  leader: reviewer",
        ""
      ].join("\n")
    );

    await expect(loadManifest(path.join(directory, "Spawnfile"))).rejects.toThrow(
      /Structure leader is not a declared team member/
    );
  });

  it("rejects external that references undeclared member", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bad-structure-external-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: broken-team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: analyst",
        "    ref: ./agents/a",
        "",
        "structure:",
        "  mode: swarm",
        "  external:",
        "    - reviewer",
        ""
      ].join("\n")
    );

    await expect(loadManifest(path.join(directory, "Spawnfile"))).rejects.toThrow(
      /Structure external references undeclared member/
    );
  });

  it("rejects invalid manifest schemas", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-invalid-schema-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      ['spawnfile_version: "0.2"', "kind: agent", "name: broken", ""].join("\n")
    );

    await expect(loadManifest(path.join(directory, "Spawnfile"))).rejects.toThrow(
      /Invalid Spawnfile manifest/
    );
  });
});

describe("normalizeRuntimeBinding", () => {
  it("returns undefined for missing runtime bindings", () => {
    expect(normalizeRuntimeBinding(undefined)).toBeUndefined();
  });

  it("normalizes shorthand runtime values", () => {
    expect(normalizeRuntimeBinding("openclaw")).toEqual({
      name: "openclaw",
      options: {}
    });
  });

  it("normalizes object runtime bindings", () => {
    expect(
      normalizeRuntimeBinding({
        name: "picoclaw",
        options: { restrict_to_workspace: true }
      })
    ).toEqual({
      name: "picoclaw",
      options: { restrict_to_workspace: true }
    });
  });
});

describe("mergeExecution", () => {
  it("returns the child execution when there is no parent", () => {
    expect(
      mergeExecution(undefined, {
        sandbox: { mode: "workspace" }
      })
    ).toEqual({
      sandbox: { mode: "workspace" }
    });
  });

  it("returns the parent execution when there is no child", () => {
    expect(
      mergeExecution(
        {
          workspace: { isolation: "isolated" }
        },
        undefined
      )
    ).toEqual({
      workspace: { isolation: "isolated" }
    });
  });

  it("merges parent and child execution intent", () => {
    expect(
      mergeExecution(
        {
          sandbox: { mode: "workspace" },
          workspace: { isolation: "isolated" }
        },
        {
          sandbox: { mode: "sandboxed" }
        }
      )
    ).toEqual({
      sandbox: { mode: "sandboxed" },
      workspace: { isolation: "isolated" }
    });
  });

  it("merges model fallback and primary settings", () => {
    expect(
      mergeExecution(
        {
          model: {
            fallback: [{ name: "claude-haiku", provider: "anthropic" }],
            primary: { name: "claude-sonnet", provider: "anthropic" }
          }
        },
        {
          model: {
            primary: { name: "gpt-5", provider: "openai" }
          }
        }
      )
    ).toEqual({
      model: {
        fallback: [{ name: "claude-haiku", provider: "anthropic" }],
        primary: { name: "gpt-5", provider: "openai" }
      },
      sandbox: undefined,
      workspace: undefined
    });
  });

  it("rejects merged execution models without a primary model", () => {
    expect(() =>
      mergeExecution(
        {
          model: {
            fallback: [{ name: "claude-haiku", provider: "anthropic" }]
          }
        } as never,
        {}
      )
    ).toThrow(/primary model/);
  });

  it("rejects merged execution sandboxes without a mode", () => {
    expect(() =>
      mergeExecution(
        {
          sandbox: {}
        } as never,
        {}
      )
    ).toThrow(/sandbox is missing mode/);
  });

  it("rejects merged execution workspaces without isolation", () => {
    expect(() =>
      mergeExecution(
        {
          workspace: {}
        } as never,
        {}
      )
    ).toThrow(/workspace is missing isolation/);
  });
});
