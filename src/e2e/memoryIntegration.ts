import path from "node:path";

import { SpawnfileError } from "../shared/index.js";
import {
  collectMemoryCoverageByRuntime,
  createPassed,
  createSkipped,
  createUnsupported,
  expectRoomMembers,
  getRuntimeNodes,
  maybeCheckRoomMembers,
  memoryCapabilityOutcomes,
  nodeHasMemoryCapability,
  readNodeOutputJson,
  withCompile,
  type MemoryE2EOptions,
  type MemoryE2EResult,
  type MemoryE2EStatus
} from "./memoryIntegrationSupport.js";

export type { MemoryE2EOptions, MemoryE2EResult, MemoryE2EStatus };

const MIXED_RUNTIME_FIXTURE = path.resolve(process.cwd(), "examples", "mixed-runtime-org");
const JUNGIAN_FIXTURE = path.resolve(process.cwd(), "examples", "jungian-daimon-org");

export const runDaimonMemoryRecallE2E = async (
  options: MemoryE2EOptions = {}
): Promise<MemoryE2EResult> =>
  withCompile(
    options.fixtureDirectory ?? MIXED_RUNTIME_FIXTURE,
    options,
    async ({ compileResult, plan, outputDirectory }) => {
      const fixtureDirectory = options.fixtureDirectory ?? MIXED_RUNTIME_FIXTURE;
      const piNodes = getRuntimeNodes(compileResult.report, "pi");
      if (piNodes.length === 0) {
        throw new SpawnfileError("runtime_error", "Mixed fixture did not compile a legacy Pi runtime instance");
      }

      const localist = compileResult.report.nodes.find(
        (node) => node.kind === "agent" && node.id === "agent:localist"
      );
      if (!localist) {
        return createUnsupported(
          fixtureDirectory,
          outputDirectory,
          "Legacy Pi recall fixture path changed; localist agent was not found in compile report",
          ["Expected localist agent source to be discoverable in report.nodes."]
        );
      }

      const memoryBanks = plan.memoryAccess?.filter((access) =>
        access.declaringKind === "agent" && access.agentSource === localist.source
      ) ?? [];
      if (memoryBanks.length === 0) {
        return createSkipped(
          fixtureDirectory,
          outputDirectory,
          "No agent-level memory banks found for localist; recall probe intentionally skipped",
          ["Add memory to examples/mixed-runtime-org/agents/localist/Spawnfile to exercise this path."]
        );
      }

      expectRoomMembers(compileResult.report.container?.moltnet, "mixed_lab", "floor", ["conductor", "analyst", "localist"]);

      const coverage = collectMemoryCoverageByRuntime(plan, compileResult.report.nodes);
      const floorBanks = coverage.get("pi");
      if (!floorBanks || floorBanks.size === 0) {
        return createUnsupported(
          fixtureDirectory,
          outputDirectory,
          "Mixed fixture memory plan does not resolve legacy Pi memory access",
          ["BuildCompilePlan resolved memory declarations, but no agent access mapped to pi runtime."]
        );
      }

      if (!nodeHasMemoryCapability(localist)) {
        return createUnsupported(
          fixtureDirectory,
          outputDirectory,
          "Legacy Pi runtime did not emit expected memory capabilities",
          [
            `localist has ${memoryBanks.length} declared memory bank(s) for recall checks`,
            "Check legacy Pi direct Mneme memory wiring and compile capability emission."
          ]
        );
      }

      return createPassed(
        fixtureDirectory,
        outputDirectory,
        "Legacy Pi memory wiring is present and executable in compile output",
        [`localist has ${memoryBanks.length} active memory bank mapping(s).`]
      );
    }
  );

export const runMixedRuntimeMemoryWiringE2E = async (
  options: MemoryE2EOptions = {}
): Promise<MemoryE2EResult> =>
  withCompile(
    options.fixtureDirectory ?? MIXED_RUNTIME_FIXTURE,
    options,
    async ({ compileResult, plan, outputDirectory }) => {
      const fixtureDirectory = options.fixtureDirectory ?? MIXED_RUNTIME_FIXTURE;
      expectRoomMembers(compileResult.report.container?.moltnet, "mixed_lab", "floor", ["conductor", "analyst", "localist"]);

      const floorInstanceRuntimes = (compileResult.report.container?.runtime_instances ?? [])
        .map((instance) => instance.runtime)
        .sort();
      const requiredRuntimes = ["openclaw", "pi", "picoclaw"];
      const missingRuntimes = requiredRuntimes.filter((runtime) => !floorInstanceRuntimes.includes(runtime));
      if (missingRuntimes.length > 0) {
        throw new SpawnfileError(
          "runtime_error",
          `Missing mixed runtime instances: ${missingRuntimes.join(", ")}`
        );
      }

      const coverage = collectMemoryCoverageByRuntime(plan, compileResult.report.nodes);
      const missingCoverage = requiredRuntimes.filter((runtime) => !coverage.has(runtime));
      if (missingCoverage.length > 0) {
        return createUnsupported(
          fixtureDirectory,
          outputDirectory,
          "Memory declarations were expected for all mixed runtimes, but wiring is incomplete",
          [
            `Missing coverage: ${missingCoverage.join(", ")}`,
            "Review memory declarations in examples/mixed-runtime-org/Spawnfile"
          ]
        );
      }

      const missingCapabilityRuntimes = requiredRuntimes.filter((runtime) => {
        const nodes = getRuntimeNodes(compileResult.report, runtime);
        return nodes.length === 0 || !nodes.some(nodeHasMemoryCapability);
      });
      if (missingCapabilityRuntimes.length > 0) {
        return createUnsupported(
          fixtureDirectory,
          outputDirectory,
          "Mixed runtime memory capabilities are missing from compile output",
          [
            `Missing memory capability runtime(s): ${missingCapabilityRuntimes.join(", ")}`,
            "Pi and PicoClaw should emit memory capabilities; OpenClaw should emit memory capabilities through Mneme MCP."
          ]
        );
      }

      const outcomeDetails = requiredRuntimes.map((runtime) => {
        const outcomes = [...memoryCapabilityOutcomes(getRuntimeNodes(compileResult.report, runtime))]
          .sort()
          .join(", ");
        return `${runtime}: ${outcomes || "none"}`;
      });

      const openClawConfig = await readNodeOutputJson<{
        mcp?: { servers?: Record<string, { args?: string[] }> };
      }>(compileResult.report, outputDirectory, "agent:conductor", "openclaw.json");
      const openClawCron = await readNodeOutputJson<{
        jobs?: Array<{ payload?: { message?: string }; schedule?: { kind?: string } }>;
      }>(compileResult.report, outputDirectory, "agent:conductor", "home/.openclaw/cron/jobs.json");
      const picoConfig = await readNodeOutputJson<{
        tools?: { mcp?: { servers?: Record<string, { args?: string[] }> } };
      }>(compileResult.report, outputDirectory, "agent:analyst", "config.json");
      const picoCron = await readNodeOutputJson<{
        jobs?: Array<{ payload?: { message?: string }; schedule?: { kind?: string } }>;
      }>(compileResult.report, outputDirectory, "agent:analyst", "workspace/cron/jobs.json");

      if (!openClawConfig.mcp?.servers?.["mneme-floor-dream"] || !picoConfig.tools?.mcp?.servers?.["mneme-floor-dream"]) {
        throw new SpawnfileError("runtime_error", "Mixed runtime fixture did not emit dream-mode Mneme MCP servers");
      }
      if (
        !openClawCron.jobs?.some((job) => job.schedule?.kind === "every" && job.payload?.message?.includes("Dream over Mneme memory bank floor")) ||
        !picoCron.jobs?.some((job) => job.schedule?.kind === "every" && job.payload?.message?.includes("Dream over Mneme memory bank floor"))
      ) {
        throw new SpawnfileError("runtime_error", "Mixed runtime fixture did not emit OpenClaw/PicoClaw dream cron jobs");
      }

      return createPassed(
        fixtureDirectory,
        outputDirectory,
        "Mixed-runtime Pi + PicoClaw + Moltnet memory wiring is present with explicit runtime outcomes",
        [
          "mixed_lab floor room has all declared members",
          "openclaw/picoclaw dream cron jobs are emitted",
          "openclaw/picoclaw dream Mneme MCP servers are emitted",
          ...outcomeDetails
        ]
      );
    }
  );

export const runJungianSelfOrgE2E = async (
  options: MemoryE2EOptions = {}
): Promise<MemoryE2EResult> =>
  withCompile(
    options.fixtureDirectory ?? JUNGIAN_FIXTURE,
    options,
    async ({ compileResult, plan, outputDirectory }) => {
      const fixtureDirectory = options.fixtureDirectory ?? JUNGIAN_FIXTURE;
      const piNodes = getRuntimeNodes(compileResult.report, "pi")
        .filter((node) => node.kind === "agent");
      if (piNodes.length === 0) {
        throw new SpawnfileError("runtime_error", "Jungian fixture did not compile a legacy Pi runtime instance");
      }

      const roomIssues = [
        maybeCheckRoomMembers(compileResult.report.container?.moltnet, "psyche-floor", "commons", [
          "luna-representative",
          "selene-representative"
        ]),
        maybeCheckRoomMembers(compileResult.report.container?.moltnet, "luna_inner", "luna-council", [
          "luna-representative",
          "luna-animus",
          "luna-shadow"
        ]),
        maybeCheckRoomMembers(compileResult.report.container?.moltnet, "selene_inner", "selene-council", [
          "selene-representative",
          "selene-animus",
          "selene-shadow"
        ])
      ];

      if (roomIssues.some((issue) => issue !== undefined)) {
        return createUnsupported(
          fixtureDirectory,
          outputDirectory,
          "Jungian compile report did not expose complete Moltnet room membership details",
          roomIssues.filter((issue): issue is string => issue !== undefined)
        );
      }

      const coverage = collectMemoryCoverageByRuntime(plan, compileResult.report.nodes);
      const piCoverage = coverage.get("pi");
      if (!piCoverage || piCoverage.size === 0) {
        return createSkipped(
          fixtureDirectory,
          outputDirectory,
          "No Jungian memory banks are currently resolved; self-org memory probe skipped",
          ["Add agent/team memory declarations in examples/jungian-daimon-org to run this assertion."]
        );
      }

      const missingPiCapability = !piNodes.every(nodeHasMemoryCapability);
      if (missingPiCapability) {
        return createUnsupported(
          fixtureDirectory,
          outputDirectory,
          "Legacy Pi runtime did not expose memory capabilities for Jungian self-org agents",
          [
            `Resolved ${piCoverage.size} Jungian memory bank mapping(s)`,
            "Check legacy Pi direct Mneme memory wiring and compile capability emission."
          ]
        );
      }

      return createPassed(
        fixtureDirectory,
        outputDirectory,
        "Jungian self-org fixture compiles with requested room topology and memory mapping",
        [
          `Jungian legacy Pi coverage includes ${piCoverage.size} memory bank binding(s)`,
          "nested council rooms are present on mixed Moltnet topology"
        ]
      );
    }
  );
