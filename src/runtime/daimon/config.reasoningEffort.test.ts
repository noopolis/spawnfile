import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildCompilePlan } from "../../compiler/buildCompilePlan.js";
import type { ResolvedAgentNode } from "../../compiler/types.js";

import { daimonAdapter } from "./adapter.js";
import { createDaimonContainerTargets, DAIMON_CONFIG_FILE } from "./config.js";

const emitEngine = async (auth: string, reasoning_effort?: string, engine = auth) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-reasoning-effort-"));
  try {
    await writeFile(path.join(directory, "AGENTS.md"), "# Instructions\n");
    await writeFile(path.join(directory, "Spawnfile"), JSON.stringify({
      spawnfile_version: "0.1",
      kind: "agent",
      name: "test",
      runtime: { name: "daimon", options: { engine } },
      execution: {
        model: {
          primary: {
            auth: { method: auth },
            name: auth === "grok" ? "grok-4.6" : "gpt-5.4-codex",
            provider: auth === "grok" ? "xai" : "openai",
            ...(reasoning_effort === undefined ? {} : { reasoning_effort })
          }
        },
        sandbox: { mode: "workspace" }
      },
      workspace: { docs: { system: "AGENTS.md" } }
    }));
    // Compile the node returned by the real model resolution/validation path.
    const plan = await buildCompilePlan(directory);
    const planned = plan.nodes[0]!;
    const node = planned.value as ResolvedAgentNode;
    const compiled = await daimonAdapter.compileAgent(node);
    const [target] = await createDaimonContainerTargets([
      { emittedFiles: compiled.files, id: planned.id, kind: "agent", slug: planned.slug, value: node }
    ]);
    const config = JSON.parse(target!.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content);
    return config.agents[0].engine;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("Daimon reasoning effort lowering", () => {
  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"])("lowers declared Codex effort %s", async (reasoningEffort) => {
    expect(await emitEngine("codex", reasoningEffort)).toEqual({ kind: "codex", model: "gpt-5.4-codex", reasoningEffort });
  });

  it.each([
    ["agy", /Daimon AGY agents must omit Spawnfile execution.model/u],
    ["grok", /must use provider xai with auth.method grok/u],
    ["other", /engine must be one of/u]
  ])("refuses Codex effort on Daimon engine %s", async (engine, message) => {
    await expect(emitEngine("codex", "high", engine)).rejects.toMatchObject({
      code: "validation_error", message: expect.stringMatching(message)
    });
  });

  it("omits Codex effort when absent", async () => {
    expect(await emitEngine("codex")).toEqual({ kind: "codex", model: "gpt-5.4-codex" });
  });

  it.each(["low", "medium", "high"])("keeps Grok engine intent unchanged for %s", async (reasoningEffort) => {
    expect(await emitEngine("grok", reasoningEffort)).toEqual({ kind: "grok", model: "grok-4.6", reasoningEffort });
  });
});

describe("Daimon Codex fallback reasoning effort", () => {
  it("refuses an effort declared on a fallback instead of dropping it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-fallback-effort-"));
    try {
      await writeFile(path.join(directory, "AGENTS.md"), "# Instructions\n");
      await writeFile(path.join(directory, "Spawnfile"), JSON.stringify({
        spawnfile_version: "0.1", kind: "agent", name: "test",
        runtime: { name: "daimon", options: { engine: "codex" } },
        execution: {
          model: {
            primary: { auth: { method: "codex" }, name: "gpt-5.4-codex", provider: "openai" },
            fallback: [{ auth: { method: "codex" }, name: "gpt-5.4-mini", provider: "openai", reasoning_effort: "high" }]
          },
          sandbox: { mode: "workspace" }
        },
        workspace: { docs: { system: "AGENTS.md" } }
      }));
      const plan = await buildCompilePlan(directory);
      const planned = plan.nodes[0]!;
      const node = planned.value as ResolvedAgentNode;
      expect(() => daimonAdapter.preflightAgent!(node, planned.id)).toThrow(/only from the primary model/u);
      const compiled = await daimonAdapter.compileAgent(node);
      await expect(createDaimonContainerTargets([
        { emittedFiles: compiled.files, id: planned.id, kind: "agent", slug: planned.slug, value: node }
      ])).rejects.toThrow(/only from the primary model/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
