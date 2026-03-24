import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { buildCompilePlan } from "./buildCompilePlan.js";

const fixturesRoot = path.resolve(process.cwd(), "fixtures");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("buildCompilePlan", () => {
  it("builds a single-agent plan", async () => {
    const plan = await buildCompilePlan(path.join(fixturesRoot, "single-agent"));

    expect(plan.nodes).toHaveLength(1);
    expect(plan.runtimes.openclaw.nodeIds).toHaveLength(1);
  });

  it("applies default workspace and sandbox execution intent when omitted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-default-execution-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(path.join(directory, "IDENTITY.md"), "# Identity\n");
    await writeUtf8File(path.join(directory, "SOUL.md"), "# Soul\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: openai",
        "      name: gpt-5.4",
        "",
        "docs:",
        "  identity: IDENTITY.md",
        "  soul: SOUL.md",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agentNode = plan.nodes.find((node) => node.kind === "agent");

    expect(agentNode?.kind).toBe("agent");
    if (!agentNode || agentNode.value.kind !== "agent") {
      throw new Error("Expected agent node");
    }

    expect(agentNode.value.execution?.workspace).toEqual({ isolation: "isolated" });
    expect(agentNode.value.execution?.sandbox).toEqual({ mode: "workspace" });
  });

  it("builds a subagent graph", async () => {
    const plan = await buildCompilePlan(path.join(fixturesRoot, "agent-with-subagents"));

    expect(plan.nodes.filter((node) => node.kind === "agent")).toHaveLength(3);
    expect(plan.edges.filter((edge) => edge.kind === "subagent")).toHaveLength(2);
  });

  it("builds a multi-runtime team graph", async () => {
    const plan = await buildCompilePlan(path.join(fixturesRoot, "multi-runtime-team"));

    expect(Object.keys(plan.runtimes).sort()).toEqual(["openclaw", "picoclaw", "tinyclaw"]);
    expect(plan.nodes.find((node) => node.kind === "team")).toBeTruthy();
  });

  it("rejects cyclic subagent graphs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-cycle-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "subagents", "loop"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(path.join(directory, "subagents", "loop", "AGENTS.md"), "# Loop\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        "",
        "subagents:",
        "  - id: loop",
        "    ref: ./subagents/loop",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "subagents", "loop", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: loop",
        "",
        "runtime: openclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        "",
        "subagents:",
        "  - id: self",
        "    ref: .",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/Cycle detected/);
  });

  it("reuses repeated agent refs when the resolved context is identical", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-duplicate-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "shared"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "shared", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "agents", "shared", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: shared", "", "runtime: openclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: one",
        "    ref: ./agents/shared",
        "  - id: two",
        "    ref: ./agents/shared",
        "",
        "structure:",
        "  mode: swarm",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    expect(plan.nodes.filter((node) => node.kind === "agent")).toHaveLength(1);
  });

  it("rejects agents that do not declare a runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-missing-runtime-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: root", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/does not declare a runtime/);
  });

  it("rejects runtime and model auth combinations that the adapter does not support", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-unsupported-auth-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: tinyclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: openai",
        "      name: gpt-5",
        "    auth:",
        "      method: api_key",
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /does not support model auth method api_key for provider openai/
    );
  });

  it("accepts custom and local model targets on runtimes that support them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-custom-models-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: picoclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: custom",
        "      name: foo-large",
        "      auth:",
        "        method: api_key",
        "        key: CUSTOM_API_KEY",
        "      endpoint:",
        "        compatibility: anthropic",
        "        base_url: https://llm.example.com/v1",
        "    fallback:",
        "      - provider: local",
        "        name: qwen2.5:14b",
        "        auth:",
        "          method: none",
        "        endpoint:",
        "          compatibility: openai",
        "          base_url: http://host.docker.internal:11434/v1",
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    expect(plan.nodes).toHaveLength(1);
  });

  it("rejects unknown runtime bindings during graph resolution", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-unknown-runtime-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: mysteryclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/Unknown runtime binding/);
  });

  it("rejects exploratory runtimes before adapter execution", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-exploratory-runtime-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: nullclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/exploratory/);
  });

  it("rejects subagents whose local runtime differs from the parent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-subagent-runtime-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "subagents", "worker"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(path.join(directory, "subagents", "worker", "AGENTS.md"), "# Worker\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        "",
        "subagents:",
        "  - id: worker",
        "    ref: ./subagents/worker",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "subagents", "worker", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: worker",
        "",
        "runtime: picoclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/must match parent runtime/);
  });

  it("rejects subagent refs that point to team manifests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-subagent-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "subagents", "team"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(path.join(directory, "subagents", "team", "TEAM.md"), "# Team\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        "",
        "subagents:",
        "  - id: worker",
        "    ref: ./subagents/team",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "subagents", "team", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: nested-team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members: []",
        "",
        "structure:",
        "  mode: swarm",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/Expected agent manifest, got team/);
  });

  it("reuses repeated nested team refs when the resolved context is identical", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-duplicate-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "teams", "inner", "agents", "a"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "teams", "inner", "TEAM.md"), "# Inner\n");
    await writeUtf8File(path.join(directory, "teams", "inner", "agents", "a", "AGENTS.md"), "# A\n");
    await writeUtf8File(
      path.join(directory, "teams", "inner", "agents", "a", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: a", "", "runtime: tinyclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "teams", "inner", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: inner",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: a",
        "    ref: ./agents/a",
        "",
        "structure:",
        "  mode: swarm",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: outer",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: one",
        "    ref: ./teams/inner",
        "  - id: two",
        "    ref: ./teams/inner",
        "",
        "structure:",
        "  mode: swarm",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    expect(plan.nodes.filter((node) => node.kind === "team")).toHaveLength(2);
  });
});
