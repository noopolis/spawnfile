import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { buildCompilePlan, compileProject } from "../compiler/index.js";
import { removeDirectory } from "../filesystem/index.js";
import {
  collectMemoryCoverageByRuntime,
  getRuntimeNodes,
  maybeCheckRoomMembers,
  nodeHasMemoryCapability,
  readNodeOutputJson
} from "./memoryIntegrationSupport.js";
import type { B18PreflightCheck, PreflightCheckStatus } from "./preflightTypes.js";

export interface CompileEvidence {
  daimon: B18PreflightCheck;
  mneme: B18PreflightCheck;
  moltnet: B18PreflightCheck;
  openclaw: B18PreflightCheck;
  picoclaw: B18PreflightCheck;
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const createCheck = (
  id: string,
  label: string,
  status: PreflightCheckStatus,
  reason: string,
  fixtureDirectory: string
): B18PreflightCheck => ({
  id,
  name: label,
  reason,
  status
});

export const probeCompileEvidence = async (
  fixtureDirectory: string,
  timeoutMs: number
): Promise<CompileEvidence> => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-preflight-compile-"));
  try {
    return await withTimeout(
      (async () => {
        const [compileResult, plan] = await Promise.all([
          compileProject(fixtureDirectory, { outputDirectory }),
          buildCompilePlan(fixtureDirectory)
        ]);
        const runtimeInstances = compileResult.report.container?.runtime_instances ?? [];
        const runtimes = new Set(runtimeInstances.map((instance) => instance.runtime));
        const coverage = collectMemoryCoverageByRuntime(plan, compileResult.report.nodes);
        const roomIssue = maybeCheckRoomMembers(
          compileResult.report.container?.moltnet,
          "mixed_lab",
          "floor",
          ["conductor", "analyst", "localist"]
        );
        const openClawConfig = await readNodeOutputJson<{ mcp?: { servers?: Record<string, unknown> } }>(
          compileResult.report,
          outputDirectory,
          "agent:conductor",
          "openclaw.json"
        );
        const openClawCron = await readNodeOutputJson<{ jobs?: Array<{ payload?: { message?: string } }> }>(
          compileResult.report,
          outputDirectory,
          "agent:conductor",
          "home/.openclaw/cron/jobs.json"
        );
        const picoConfig = await readNodeOutputJson<{ tools?: { mcp?: { servers?: Record<string, unknown> } } }>(
          compileResult.report,
          outputDirectory,
          "agent:analyst",
          "config.json"
        );
        const picoCron = await readNodeOutputJson<{ jobs?: Array<{ payload?: { message?: string } }> }>(
          compileResult.report,
          outputDirectory,
          "agent:analyst",
          "workspace/cron/jobs.json"
        );
        const hasDreamPrompt = (jobs: Array<{ payload?: { message?: string } }> | undefined): boolean =>
          jobs?.some((job) => job.payload?.message?.includes("Dream over Mneme memory bank floor")) ?? false;
        const daimonReady =
          runtimes.has("daimon") &&
          coverage.has("daimon") &&
          getRuntimeNodes(compileResult.report, "daimon").some(nodeHasMemoryCapability);
        const openclawReady =
          runtimes.has("openclaw") &&
          coverage.has("openclaw") &&
          Boolean(openClawConfig.mcp?.servers?.["mneme-floor-dream"]) &&
          hasDreamPrompt(openClawCron.jobs);
        const picoclawReady =
          runtimes.has("picoclaw") &&
          coverage.has("picoclaw") &&
          Boolean(picoConfig.tools?.mcp?.servers?.["mneme-floor-dream"]) &&
          hasDreamPrompt(picoCron.jobs);

        return {
          daimon: createCheck("daimon", "Daimon", daimonReady ? "passed" : "unavailable", daimonReady ? `Mixed-runtime fixture emits Daimon memory wiring (${path.resolve(fixtureDirectory)})` : `Mixed-runtime fixture did not emit Daimon memory wiring (${path.resolve(fixtureDirectory)})`, fixtureDirectory),
          mneme: createCheck("mneme", "Mneme", daimonReady && openclawReady && picoclawReady ? "passed" : "unavailable", daimonReady && openclawReady && picoclawReady ? `Mixed-runtime fixture emits direct and MCP Mneme wiring (${path.resolve(fixtureDirectory)})` : `Mixed-runtime fixture did not emit complete Mneme wiring (${path.resolve(fixtureDirectory)})`, fixtureDirectory),
          moltnet: createCheck("moltnet", "Moltnet", roomIssue ? "unavailable" : "passed", roomIssue ?? `Mixed-runtime fixture emits Moltnet room topology (${path.resolve(fixtureDirectory)})`, fixtureDirectory),
          openclaw: createCheck("openclaw", "OpenClaw", openclawReady ? "passed" : "unavailable", openclawReady ? `Mixed-runtime fixture emits OpenClaw dream and Mneme MCP wiring (${path.resolve(fixtureDirectory)})` : `Mixed-runtime fixture did not emit OpenClaw dream or Mneme MCP wiring (${path.resolve(fixtureDirectory)})`, fixtureDirectory),
          picoclaw: createCheck("picoclaw", "PicoClaw", picoclawReady ? "passed" : "unavailable", picoclawReady ? `Mixed-runtime fixture emits PicoClaw dream and Mneme MCP wiring (${path.resolve(fixtureDirectory)})` : `Mixed-runtime fixture did not emit PicoClaw dream or Mneme MCP wiring (${path.resolve(fixtureDirectory)})`, fixtureDirectory)
        } satisfies CompileEvidence;
      })(),
      timeoutMs,
      "mixed-runtime compile preflight"
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      daimon: createCheck("daimon", "Daimon", "unavailable", reason, fixtureDirectory),
      mneme: createCheck("mneme", "Mneme", "unavailable", reason, fixtureDirectory),
      moltnet: createCheck("moltnet", "Moltnet", "unavailable", reason, fixtureDirectory),
      openclaw: createCheck("openclaw", "OpenClaw", "unavailable", reason, fixtureDirectory),
      picoclaw: createCheck("picoclaw", "PicoClaw", "unavailable", reason, fixtureDirectory)
    };
  } finally {
    await removeDirectory(outputDirectory);
  }
};
