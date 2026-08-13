import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { buildCompilePlan, compileProject } from "../compiler/index.js";
import type { CompilePlan } from "../compiler/types.js";
import type { CompileProjectResult } from "../compiler/compileProject.js";
import { readUtf8File, removeDirectory } from "../filesystem/index.js";
import type { CompileReport, ContainerMoltnetPlanSummary, NodeReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";

export type MemoryE2EStatus = "passed" | "skipped" | "unsupported";

export interface MemoryE2EResult {
  fixtureDirectory: string;
  outputDirectory: string;
  status: MemoryE2EStatus;
  summary: string;
  details: string[];
}

export interface MemoryE2EOptions {
  fixtureDirectory?: string;
  keepArtifacts?: boolean;
  outputDirectory?: string;
}

interface E2EFixtureResult {
  compileResult: CompileProjectResult;
  plan: CompilePlan;
  outputDirectory: string;
}

export const collectMemoryCoverageByRuntime = (
  plan: CompilePlan,
  compileNodes: NodeReport[]
): Map<string, Set<string>> => {
  const nodeBySource = new Map(
    compileNodes
      .filter((node) => node.runtime !== null)
      .map((node) => [node.source, node.runtime] as const)
  );
  const coverage = new Map<string, Set<string>>();

  for (const access of plan.memoryAccess ?? []) {
    const runtime = nodeBySource.get(access.agentSource);
    if (!runtime) continue;
    const set = coverage.get(runtime) ?? new Set<string>();
    set.add(access.bank.id);
    coverage.set(runtime, set);
  }

  return coverage;
};

export const nodeHasMemoryCapability = (node: NodeReport): boolean =>
  node.capabilities.some(({ key }) => key.startsWith("memory."));

export const memoryCapabilityOutcomes = (nodes: NodeReport[]): Set<string> =>
  new Set(
    nodes.flatMap((node) =>
      node.capabilities
        .filter((capability) => capability.key.startsWith("memory"))
        .map((capability) => capability.outcome)
    )
  );

export const getRuntimeNodes = (compileReport: CompileReport, runtime: string): NodeReport[] =>
  (compileReport.nodes ?? []).filter((node) => node.runtime === runtime);

export const expectRoomMembers = (
  moltnet: ContainerMoltnetPlanSummary | undefined,
  networkId: string,
  roomId: string,
  expected: string[]
): void => {
  const plan = (moltnet?.server_plans ?? []).find((entry) => entry.network_id === networkId);
  if (!plan) {
    throw new SpawnfileError("runtime_error", `Missing compiled Moltnet server plan for ${networkId}`);
  }

  const room = (plan.rooms ?? []).find((entry) => entry.id === roomId);
  if (!room) {
    throw new SpawnfileError("runtime_error", `Missing compiled room ${roomId} in ${networkId}`);
  }

  const actual = [...room.members].sort();
  const expectedSorted = [...new Set(expected)].sort();
  if (actual.length !== expectedSorted.length || actual.some((member, index) => member !== expectedSorted[index])) {
    throw new SpawnfileError(
      "runtime_error",
      `Room ${networkId}:${roomId} members mismatch: expected [${expectedSorted.join(", ")}], got [${actual.join(", ")}]`
    );
  }
};

export const maybeCheckRoomMembers = (
  moltnet: ContainerMoltnetPlanSummary | undefined,
  networkId: string,
  roomId: string,
  expected: string[]
): string | undefined => {
  try {
    expectRoomMembers(moltnet, networkId, roomId, expected);
    return undefined;
  } catch (error) {
    return error instanceof SpawnfileError ? error.message : String(error);
  }
};

export const readNodeOutputJson = async <T>(
  compileReport: CompileReport,
  outputDirectory: string,
  nodeId: string,
  relativePath: string
): Promise<T> => {
  const node = compileReport.nodes.find((entry) => entry.id === nodeId);
  if (!node?.output_dir) {
    throw new SpawnfileError("runtime_error", `Missing output directory for ${nodeId}`);
  }

  return JSON.parse(await readUtf8File(path.join(outputDirectory, node.output_dir, relativePath))) as T;
};

export const withCompile = async (
  fixtureDirectory: string,
  options: MemoryE2EOptions,
  fn: (input: E2EFixtureResult) => Promise<MemoryE2EResult>
): Promise<MemoryE2EResult> => {
  const outputDirectory = options.outputDirectory ?? await mkdtemp(path.join(os.tmpdir(), "spawnfile-memory-e2e-"));
  const keepArtifacts = options.keepArtifacts ?? Boolean(options.outputDirectory);

  try {
    const [compileResult, plan] = await Promise.all([
      compileProject(fixtureDirectory, { outputDirectory }),
      buildCompilePlan(fixtureDirectory)
    ]);
    return await fn({ compileResult, plan, outputDirectory });
  } finally {
    if (!keepArtifacts) {
      await removeDirectory(outputDirectory);
    }
  }
};

export const createSkipped = (
  fixtureDirectory: string,
  outputDirectory: string,
  summary: string,
  details: string[] = []
): MemoryE2EResult => ({ details, fixtureDirectory, outputDirectory, status: "skipped", summary });

export const createUnsupported = (
  fixtureDirectory: string,
  outputDirectory: string,
  summary: string,
  details: string[] = []
): MemoryE2EResult => ({ details, fixtureDirectory, outputDirectory, status: "unsupported", summary });

export const createPassed = (
  fixtureDirectory: string,
  outputDirectory: string,
  summary: string,
  details: string[] = []
): MemoryE2EResult => ({ details, fixtureDirectory, outputDirectory, status: "passed", summary });
