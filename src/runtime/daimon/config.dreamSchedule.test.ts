import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAgentNode, ResolvedMemoryAccess, ResolvedMemoryBank } from "../../compiler/types.js";
import { daimonAdapter } from "./adapter.js";
import { createDaimonContainerTargets, DAIMON_CONFIG_FILE } from "./config.js";
import { hasDaimonDreamScheduleAuthority } from "./scheduleAuthority.js";
import { createDaimonTestNode } from "./testHelpers.js";

vi.mock("./scheduleAuthority.js", () => ({
  assertDaimonScheduleAuthority: vi.fn(),
  hasDaimonScheduleAuthority: vi.fn().mockResolvedValue(true),
  hasDaimonDreamScheduleAuthority: vi.fn()
}));

const accessFor = (
  id: string,
  consolidation: ResolvedMemoryBank["consolidation"],
  store: ResolvedMemoryBank["store"] = { kind: "sqlite", path: `/var/lib/spawnfile/memory/${id}/memory.sqlite` }
): ResolvedMemoryAccess => ({
  agentSource: "/tmp/agent/Spawnfile",
  declaringKind: "team",
  source: "/tmp/team/Spawnfile",
  bank: {
    consolidation, declaredBy: "team", declaredName: "lab", id, store,
    source: "/tmp/team/Spawnfile",
    index: { graph: { enabled: false }, lexical: { enabled: true }, rerank: { enabled: false }, vector: { enabled: false } },
    retention: { forgetting: "manual" }
  }
});

const compile = async (...nodes: ResolvedAgentNode[]) => {
  const compiled = await Promise.all(nodes.map((node) => daimonAdapter.compileAgent(node)));
  const [target] = await createDaimonContainerTargets(nodes.map((node, index) => ({
    emittedFiles: compiled[index]!.files, id: `agent:${node.name}`, kind: "agent", slug: node.name, value: node
  })));
  const config = JSON.parse(target!.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content);
  return { config, capabilities: compiled[0]!.capabilities, diagnostics: compiled[0]!.diagnostics };
};

const consolidationRow = (id: string, outcome: string, message: RegExp) => expect.objectContaining({
  key: `memory.${id}.consolidation`, outcome, message: expect.stringMatching(message)
});

describe("Daimon scheduled memory consolidation lowering", () => {
  beforeEach(() => vi.mocked(hasDaimonDreamScheduleAuthority).mockReset().mockResolvedValue(true));

  it("emits an independent interval dream alongside ordinary work and skips unselected banks", async () => {
    const keeper = createDaimonTestNode({
      name: "keeper",
      memoryAccess: [accessFor("other", { mode: "scheduled", schedule: "1h" }), accessFor("archive", { mode: "scheduled", schedule: "2.5m" })],
      schedule: { kind: "every", every: "20m", prompt: "Process the work queue", jitter_seconds: 8 }
    });
    const { config, capabilities, diagnostics } = await compile(keeper);

    expect(config.version).toBe("noopolis.daimon.organization-runtime.v2");
    expect(config.agents[0]).toMatchObject({
      schedule: { kind: "every", interval_ms: 1_200_000, prompt: "Process the work queue", jitter_seconds: 8 },
      memory: {
        runtimeHomePath: "/var/lib/spawnfile/memory/archive", source: "spawnfile:team:archive",
        dreamSchedule: { kind: "every", interval_ms: 150_000, prompt: expect.stringMatching(/isolated maintenance/u) }
      }
    });
    expect(config.agents[0].memory.dreamSchedule).not.toHaveProperty("jitter_seconds");
    expect(Buffer.byteLength(config.agents[0].memory.dreamSchedule.prompt, "utf8")).toBeLessThanOrEqual(4096);
    expect(capabilities).toEqual(expect.arrayContaining([
      consolidationRow("archive", "supported", /independent/u),
      consolidationRow("other", "degraded", /selected memory bank archive/u)
    ]));
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/consolidation.*other/u) }));
  });

  it("selects v2 for a dream-only UTC cron and disables each agent's omitted work schedule", async () => {
    const keeper = createDaimonTestNode({ name: "keeper", memoryAccess: [accessFor("archive", { mode: "scheduled", schedule: "  0  3 * * 1-5 " })] });
    const { config } = await compile(keeper, createDaimonTestNode({ name: "second" }));

    expect(config.version).toBe("noopolis.daimon.organization-runtime.v2");
    expect(config.agents[0].memory.dreamSchedule).toEqual({ kind: "cron", cron: "0 3 * * 1-5", timezone: "UTC", prompt: expect.stringMatching(/consolidate clear duplicates/iu) });
    expect(config.agents[0].memory.dreamSchedule.prompt).not.toMatch(/\bmemory_/u);
    expect(config.agents.map(({ schedule }: { schedule: object }) => schedule)).toEqual([{ kind: "disabled" }, { kind: "disabled" }]);
    expect(config.agents[1]).not.toHaveProperty("memory");
  });

  it("keeps the v1 memory block unchanged when the pinned image lacks dream support", async () => {
    vi.mocked(hasDaimonDreamScheduleAuthority).mockResolvedValue(false);
    const disabled = await compile(createDaimonTestNode({ memoryAccess: [accessFor("archive", { mode: "disabled", schedule: "1h" })] }));
    expect(hasDaimonDreamScheduleAuthority).not.toHaveBeenCalled();
    expect(disabled.config.version).toBe("noopolis.daimon.organization-runtime.v1");
    expect(disabled.config.agents[0]).not.toHaveProperty("schedule");
    expect(disabled.capabilities.some(({ key }) => key.endsWith(".consolidation"))).toBe(false);

    const declined = await compile(createDaimonTestNode({ memoryAccess: [accessFor("archive", { mode: "scheduled", schedule: "1h" })] }));
    expect(declined.config).toEqual(disabled.config);
    expect(declined.capabilities).toContainEqual(consolidationRow("archive", "degraded", /image capability receipt/u));
    expect(declined.diagnostics).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/image capability receipt/u) }));

    const ordinaryWork = await compile(createDaimonTestNode({
      memoryAccess: [accessFor("archive", { mode: "scheduled", schedule: "1h" })], schedule: { kind: "every", every: "4h" }
    }));
    expect(ordinaryWork.config.version).toBe("noopolis.daimon.organization-runtime.v2");
    expect(ordinaryWork.config.agents[0].schedule).toMatchObject({ kind: "every", interval_ms: 14_400_000 });
    expect(ordinaryWork.config.agents[0].memory).not.toHaveProperty("dreamSchedule");
  });

  it.each([
    [undefined, /consolidation.schedule is required/u], ["@daily", /five-field numeric UTC cron/u],
    ["0 0 * * * *", /five-field numeric UTC cron/u], ["0 3 31 2 *", /five-field numeric UTC cron/u],
    ["0h", /supported positive duration/u], ["366d", /supported positive duration/u]
  ])("reports a missing or unsupported schedule (%s) without emitting a dream", async (schedule, reason) => {
    const { config, capabilities } = await compile(createDaimonTestNode({ memoryAccess: [accessFor("archive", { mode: "scheduled", schedule })] }));

    expect(config.version).toBe("noopolis.daimon.organization-runtime.v1");
    expect(config.agents[0].memory).not.toHaveProperty("dreamSchedule");
    expect(capabilities).toContainEqual(consolidationRow("archive", "degraded", reason));
    expect(hasDaimonDreamScheduleAuthority).not.toHaveBeenCalled();
  });

  it("reports an unwired selected bank and never falls back to another bank's schedule", async () => {
    const { config, capabilities } = await compile(createDaimonTestNode({ memoryAccess: [
      accessFor("archive", { mode: "scheduled", schedule: "1h" }, { kind: "sqlite", path: "/tmp/memory.sqlite", persistence: { mode: "ephemeral" } }),
      accessFor("other", { mode: "scheduled", schedule: "2h" })
    ] }));

    expect(config.version).toBe("noopolis.daimon.organization-runtime.v1");
    expect(config.agents[0]).not.toHaveProperty("memory");
    expect(capabilities).toEqual(expect.arrayContaining([
      consolidationRow("archive", "degraded", /no durable file-backed mount/u),
      consolidationRow("other", "degraded", /selected memory bank archive/u)
    ]));
    expect(hasDaimonDreamScheduleAuthority).not.toHaveBeenCalled();
  });

  it("distinguishes identically named banks by their declaring sources", async () => {
    const inherited = accessFor("archive", { mode: "scheduled", schedule: "2h" });
    const local = accessFor("archive", { mode: "scheduled", schedule: "1h" }, { kind: "json", path: "/tmp/archive/memory.jsonl" });
    local.source = local.agentSource;
    local.declaringKind = "agent";
    local.bank = { ...local.bank, declaredBy: "agent", declaredName: "keeper", source: local.source };
    const { config, capabilities, diagnostics } = await compile(createDaimonTestNode({ name: "keeper", memoryAccess: [inherited, local] }));

    expect(config.agents[0].memory).toMatchObject({
      source: "spawnfile:agent:archive", runtimeHomePath: "/tmp/archive", dreamSchedule: { kind: "every", interval_ms: 3_600_000 }
    });
    expect(capabilities.filter(({ key }) => key.endsWith(".consolidation"))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: expect.stringMatching(/^memory\.archive\.agent-keeper-[0-9a-f]{8}\.consolidation$/u),
        outcome: "supported", message: expect.stringMatching(/archive declared by agent keeper/u)
      }),
      expect.objectContaining({
        key: expect.stringMatching(/^memory\.archive\.team-lab-[0-9a-f]{8}\.consolidation$/u),
        outcome: "degraded", message: expect.stringMatching(/archive declared by team lab.*selected memory bank archive declared by agent keeper/u)
      })
    ]));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      level: "warn", message: expect.stringMatching(/wires memory bank archive declared by agent keeper.*ignores archive declared by team lab/u)
    }));
  });
});
