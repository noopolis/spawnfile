import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDaimonEngineDescriptor } from "../../../runtime/daimon/index.js";
import { SpawnfileError } from "../../../shared/index.js";

/** One judge identity of a run: the engine, and the model and effort its compiled organization pins. */
export interface JudgeSpec {
  engine: string;
  model: string;
  effort?: string;
}

/** The judge's system document: one self-contained judgment per wake, answered in the reply alone. */
export const JUDGE_INSTRUCTIONS = [
  "You are a judge in a training run. Every message is one self-contained judging task.",
  "Answer it directly in your reply. Never use a tool, command, file, memory, skill or the network:",
  "a reply produced with any tool activity is discarded.",
  "When the task gives a JSON Schema, reply with exactly one JSON value that matches it and nothing else."
].join("\n");

/**
 * Writes the judge's tool-free one-agent Daimon declaration: no skills, no
 * MCP, no memory, no surfaces, no schedule. The model is pinned only where
 * the engine's descriptor makes model selection configurable; otherwise the
 * engine's own default model judges and the requested model is an assumption.
 */
export const writeJudgeAgent = async (spec: JudgeSpec, directory: string): Promise<string> => {
  const descriptor = getDaimonEngineDescriptor(spec.engine);
  if (!descriptor) throw new SpawnfileError("validation_error", `Judge engine ${spec.engine} is not a Daimon engine`);
  const { provider, method } = descriptor.auth;
  const pinned = descriptor.modelSelection.configurable && provider !== null && method !== null;
  if (pinned && spec.effort !== undefined && !descriptor.modelSelection.reasoningEfforts.includes(spec.effort)) {
    throw new SpawnfileError("validation_error", `Judge engine ${spec.engine} does not accept reasoning effort ${spec.effort}`);
  }
  const manifest = {
    spawnfile_version: "0.1",
    kind: "agent",
    name: `judge-${spec.engine}`,
    description: `Tool-free ${spec.engine} training judge`,
    runtime: { name: "daimon", options: { engine: spec.engine } },
    ...(pinned ? { execution: { model: { primary: {
      provider, name: spec.model, auth: { method }, ...(spec.effort === undefined ? {} : { reasoning_effort: spec.effort })
    } } } } : {})
  };
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, "Spawnfile");
  // JSON is YAML; the trial project re-renders it with the judge instructions as its system document.
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
};
