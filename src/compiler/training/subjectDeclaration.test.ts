import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { assertTrainingSubjectDeclaration } from "./subjectDeclaration.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const limits = { maxRequests: 48, maxTokens: 2_500_000, timeoutMs: 1_800_000 };
const declared = { max_requests: 48, max_tokens: 2_500_000, timeout_ms: 1_800_000 };
const codexExecution = { model: { primary: { provider: "openai", name: "gpt-5.5", auth: { method: "codex" } } }, sandbox: { mode: "workspace" } };
const grokExecution = { model: { primary: { provider: "xai", name: "grok-4.6", auth: { method: "grok" }, reasoning_effort: "high" } } };

/** A team whose reporter inherits nothing it is checked on: every option is declared on the member's own Spawnfile. */
const project = async (runtime: unknown, execution: unknown): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-subject-")));
  directories.push(root);
  await mkdir(path.join(root, "agents/reporter"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "Root system\n");
  await writeFile(path.join(root, "agents/reporter/AGENTS.md"), "Reporter\n");
  await writeFile(path.join(root, "Spawnfile"), stringify({ spawnfile_version: "0.1", kind: "team", name: "newsroom", mode: "hierarchical",
    lead: "reporter", members: [{ id: "reporter", ref: "./agents/reporter" }] }));
  await writeFile(path.join(root, "agents/reporter/Spawnfile"), stringify({ spawnfile_version: "0.1", kind: "agent", name: "reporter",
    runtime, execution, workspace: { docs: { system: "AGENTS.md" } } }));
  return root;
};

describe("assertTrainingSubjectDeclaration", () => {
  it("accepts a Codex subject with the strict no-network policy and no broker", async () => {
    const root = await project({ name: "daimon", options: { engine: "codex", codex_policy: "workspace-no-network" } }, codexExecution);
    await expect(assertTrainingSubjectDeclaration(root, "agent:reporter")).resolves.toBe("codex");
  });

  it("refuses a Codex subject without the policy, with turn limits, or with a broker slot", async () => {
    const loose = await project({ name: "daimon", options: { engine: "codex" } }, codexExecution);
    await expect(assertTrainingSubjectDeclaration(loose, "agent:reporter")).rejects.toThrow(/codex_policy: workspace-no-network/u);
    const strict = await project({ name: "daimon", options: { engine: "codex", codex_policy: "workspace-no-network" } }, codexExecution);
    await expect(assertTrainingSubjectDeclaration(strict, "agent:reporter", { limits, workerConfigVariant: "clocked" }))
      .rejects.toThrow(/no broker slot and no turn_limits/u);
  });

  it("accepts a Grok subject whose declared turn limits equal the clocked broker's", async () => {
    const root = await project({ name: "daimon", options: { engine: "grok", turn_limits: declared } }, grokExecution);
    await expect(assertTrainingSubjectDeclaration(root, "agent:reporter", { limits, workerConfigVariant: "clocked" })).resolves.toBe("grok");
  });

  it.each(["maxRequests", "maxTokens", "timeoutMs"] as const)("refuses a Grok broker whose %s differs from the declaration", async (name) => {
    const root = await project({ name: "daimon", options: { engine: "grok", turn_limits: declared } }, grokExecution);
    await expect(assertTrainingSubjectDeclaration(root, "agent:reporter", { limits: { ...limits, [name]: limits[name] - 1 }, workerConfigVariant: "clocked" }))
      .rejects.toThrow(/differs from the broker limit/u);
  });

  it("refuses undeclared or partial Grok turn limits, an unclocked slot and a missing broker", async () => {
    const undeclared = await project({ name: "daimon", options: { engine: "grok" } }, grokExecution);
    await expect(assertTrainingSubjectDeclaration(undeclared, "agent:reporter", { limits, workerConfigVariant: "clocked" }))
      .rejects.toThrow(/turn_limits.max_requests \(undeclared\)/u);
    const partial = await project({ name: "daimon", options: { engine: "grok", turn_limits: { max_requests: 48, max_tokens: 2_500_000 } } }, grokExecution);
    await expect(assertTrainingSubjectDeclaration(partial, "agent:reporter", { limits, workerConfigVariant: "clocked" }))
      .rejects.toThrow(/turn_limits.timeout_ms \(undeclared\)/u);
    const root = await project({ name: "daimon", options: { engine: "grok", turn_limits: declared } }, grokExecution);
    await expect(assertTrainingSubjectDeclaration(root, "agent:reporter", { limits, workerConfigVariant: "unclocked" })).rejects.toThrow(/clocked/u);
    await expect(assertTrainingSubjectDeclaration(root, "agent:reporter")).rejects.toThrow(/requires its leased broker slot/u);
  });

  it("refuses other runtimes, other engines and unknown agents", async () => {
    const pico = await project({ name: "picoclaw" }, codexExecution);
    await expect(assertTrainingSubjectDeclaration(pico, "agent:reporter")).rejects.toThrow(/must declare runtime daimon/u);
    const agy = await project({ name: "daimon", options: { engine: "agy" } }, undefined);
    await expect(assertTrainingSubjectDeclaration(agy, "agent:reporter")).rejects.toThrow(/engine agy; only codex and grok/u);
    const root = await project({ name: "daimon", options: { engine: "codex", codex_policy: "workspace-no-network" } }, codexExecution);
    await expect(assertTrainingSubjectDeclaration(root, "agent:editor")).rejects.toThrow(/No canonical agent/u);
  });
});
