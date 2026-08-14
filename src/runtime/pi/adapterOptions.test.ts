import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { piAdapter } from "./adapter.js";
import { createPiTestNode } from "./testHelpers.js";

describe("piAdapter engine options and target variants", () => {
  it("serializes runtime engine options for mixed CLI-backed Pi agents", async () => {
    const codexAgent = createPiTestNode({
      name: "codex-agent",
      runtime: { name: "pi", options: { engine: "codex" } },
      source: "/tmp/codex/Spawnfile"
    });
    const claudeAgent = createPiTestNode({
      name: "claude-agent",
      runtime: { name: "pi", options: { engine: "claude" } },
      source: "/tmp/claude/Spawnfile"
    });
    const grokAgent = createPiTestNode({
      name: "grok-agent",
      runtime: { name: "pi", options: { engine: "grok" } },
      source: "/tmp/grok/Spawnfile"
    });
    const agyAgent = createPiTestNode({
      name: "agy-agent",
      runtime: { name: "pi", options: { engine: "agy" } },
      source: "/tmp/agy/Spawnfile"
    });

    const targets = await piAdapter.createContainerTargets?.([
      {
        emittedFiles: (await piAdapter.compileAgent(codexAgent)).files,
        id: "agent:codex",
        kind: "agent",
        slug: "codex",
        value: codexAgent
      },
      {
        emittedFiles: (await piAdapter.compileAgent(claudeAgent)).files,
        id: "agent:claude",
        kind: "agent",
        slug: "claude",
        value: claudeAgent
      },
      {
        emittedFiles: (await piAdapter.compileAgent(grokAgent)).files,
        id: "agent:grok",
        kind: "agent",
        slug: "grok",
        value: grokAgent
      },
      {
        emittedFiles: (await piAdapter.compileAgent(agyAgent)).files,
        id: "agent:agy",
        kind: "agent",
        slug: "agy",
        value: agyAgent
      }
    ]);

    const config = JSON.parse(targets?.[0]?.files.find((file) => file.path === "pi-app.json")?.content ?? "{}");
    expect(config.agents.map((agent: { engine: { kind: string }; id: string }) => ({
      engine: agent.engine.kind,
      id: agent.id
    }))).toEqual([
      { engine: "codex", id: "agent:codex" },
      { engine: "claude", id: "agent:claude" },
      { engine: "grok", id: "agent:grok" },
      { engine: "agy", id: "agent:agy" }
    ]);
  });

  it("emits Pi models.json for local Ollama-compatible endpoints", async () => {
    const local = createPiTestNode({
      execution: {
        model: {
          primary: {
            auth: { method: "none" },
            endpoint: {
              base_url: "http://127.0.0.1:11434/v1",
              compatibility: "openai"
            },
            name: "llama3.2",
            provider: "local"
          }
        },
        sandbox: { mode: "workspace" }
      },
      runtime: {
        name: "pi",
        options: { thinking: "off", thinking_format: "qwen" }
      }
    });
    const compiled = await piAdapter.compileAgent(local);
    const targets = await piAdapter.createContainerTargets?.([
      {
        emittedFiles: compiled.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: local
      }
    ]);

    const config = JSON.parse(targets?.[0]?.files.find((file) => file.path === "pi-app.json")?.content ?? "{}");
    const models = JSON.parse(
      targets?.[0]?.files.find((file) => file.path === "home/.pi/agent/models.json")?.content ?? "{}"
    );
    const provider = config.agents[0]?.model.provider as string;
    expect(provider).toMatch(/^local-openai-llama3-2-[a-f0-9]{8}$/);
    expect(config.agents[0]?.model.name).toBe("llama3.2");
    expect(models.providers[provider]).toMatchObject({
      api: "openai-completions",
      apiKey: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [
        {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
          id: "llama3.2",
          reasoning: true,
          compat: {
            thinkingFormat: "qwen"
          },
          thinkingLevelMap: {
            high: "high",
            low: "low",
            medium: "medium",
            minimal: "low",
            off: "none",
            xhigh: "max"
          }
        }
      ]
    });
  });

  it("skips container targets when no agent inputs are present", async () => {
    await expect(piAdapter.createContainerTargets?.([])).resolves.toEqual([]);
  });

  it("warns for unused runtime options", () => {
    expect(piAdapter.validateRuntimeOptions?.({
      engine: "codex",
      experimental: true,
      restrict_to_workspace: true
    })).toEqual([
      {
        level: "warn",
        message: "Pi runtime option experimental is not used yet"
      }
    ]);
  });

  it("rejects unsupported Pi engine options", () => {
    expect(piAdapter.validateRuntimeOptions?.({
      engine: "unknown"
    })).toEqual([
      {
        level: "error",
        message: "Pi runtime option engine must be one of agy, claude, codex, grok, pi, scripted"
      }
    ]);
  });

  it("accepts explicit Pi thinking levels and rejects unknown values", () => {
    expect(piAdapter.validateRuntimeOptions?.({ thinking: "minimal" })).toEqual([]);
    expect(piAdapter.validateRuntimeOptions?.({ thinking: "fastest" })).toEqual([
      {
        level: "error",
        message: "Pi runtime option thinking must be one of off, minimal, low, medium, high, xhigh"
      }
    ]);
  });

  it("accepts an empty Pi builtin-tool set and rejects invalid lists", () => {
    expect(piAdapter.validateRuntimeOptions?.({ tools: [] })).toEqual([]);
    expect(piAdapter.validateRuntimeOptions?.({ tools: ["read", "read"] })).toEqual([
      {
        level: "error",
        message: "Pi runtime option tools must contain unique values from read, write, edit, bash, grep, find, ls"
      }
    ]);
    expect(piAdapter.validateRuntimeOptions?.({ tools: ["world_act"] })).toEqual([
      {
        level: "error",
        message: "Pi runtime option tools must contain unique values from read, write, edit, bash, grep, find, ls"
      }
    ]);
  });

  it("accepts a scripted engine with engine_command and does not warn about the option", () => {
    expect(piAdapter.validateRuntimeOptions?.({
      engine: "scripted",
      engine_command: "harness/office-engine.mjs"
    })).toEqual([]);
  });

  it("rejects a scripted engine missing engine_command", () => {
    expect(piAdapter.validateRuntimeOptions?.({
      engine: "scripted"
    })).toEqual([
      {
        level: "error",
        message: "Pi runtime option engine_command is required (a fixture-relative script path) when engine is scripted"
      }
    ]);
  });

  it("rejects a scripted engine with a blank engine_command", () => {
    expect(piAdapter.validateRuntimeOptions?.({
      engine: "scripted",
      engine_command: "   "
    })).toEqual([
      {
        level: "error",
        message: "Pi runtime option engine_command is required (a fixture-relative script path) when engine is scripted"
      }
    ]);
  });

  it("stages a scripted engine's engine_command script as a workspace file and reports engine kind per node", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("../../../fixtures/office-sim/harness", import.meta.url)
    );
    const scriptedAgent = createPiTestNode({
      name: "eleanor",
      runtime: { name: "pi", options: { engine: "scripted", engine_command: "office-engine.mjs" } },
      source: path.join(fixtureRoot, "Spawnfile")
    });

    const compiled = await piAdapter.compileAgent(scriptedAgent);
    const stagedFile = compiled.files.find((file) => file.path === "workspace/engine/office-engine.mjs");
    expect(stagedFile).toBeDefined();
    expect(stagedFile?.mode).toBe(0o755);
    expect(stagedFile?.content).toContain("--prompt-file");

    const targets = await piAdapter.createContainerTargets?.([
      {
        emittedFiles: compiled.files,
        id: "agent:eleanor",
        kind: "agent",
        slug: "eleanor",
        value: scriptedAgent
      }
    ]);

    expect(targets?.[0]?.engineByNodeId).toEqual({ "agent:eleanor": "scripted" });
    expect(targets?.[0]?.files.map((file) => file.path)).toContain(
      "workspace/agents/eleanor/engine/office-engine.mjs"
    );

    const config = JSON.parse(targets?.[0]?.files.find((file) => file.path === "pi-app.json")?.content ?? "{}");
    expect(config.agents[0]).toMatchObject({
      engine: { kind: "scripted" },
      engine_command: "engine/office-engine.mjs"
    });
  });

  it("throws when a scripted engine's engine_command file does not exist on disk", async () => {
    const scriptedAgent = createPiTestNode({
      name: "ghost",
      runtime: { name: "pi", options: { engine: "scripted", engine_command: "does-not-exist.mjs" } },
      source: "/tmp/spawnfile-scripted-engine-missing/Spawnfile"
    });

    await expect(piAdapter.compileAgent(scriptedAgent)).rejects.toThrow();
  });
});
