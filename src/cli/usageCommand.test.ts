import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeploymentRecord } from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";

import { executeUsageCommand } from "./usageCommand.js";
import { collectOrganizationUsage, selectUsageDeployment } from "./usageCommandLive.js";

const line = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: "noopolis.daimon.turn-usage.v1",
  agent: "cogsworth",
  wake: "wake-1",
  engine: "grok",
  at: new Date().toISOString(),
  input: 8_746,
  output: 29,
  cache_read: 5_760,
  cache_write: 0,
  total: 14_535,
  calls: 1,
  notional_usd: 0.0035,
  complete: true,
  ...overrides
});

const record = (units: Partial<DeploymentRecord["units"][number]>[] = [{}]): DeploymentRecord => ({
  auth_profile: null,
  compile_fingerprint: "fingerprint",
  created_at: new Date().toISOString(),
  manager: "docker",
  name: "daimon-organization",
  output_directory: "/tmp/out",
  source: { kind: "project", root: "/tmp/project" },
  target: { kind: "host", value: "unix:///var/run/docker.sock" },
  units: units.map((unit, index) => ({
    container_id: `container-${index}`,
    container_name: `spawnfile-${index}`,
    contains: [
      { id: "cogsworth", kind: "agent" as const },
      { id: "foreman", kind: "agent" as const },
      { id: "brass", kind: "agent" as const }
    ],
    id: `unit-${index}`,
    image_id: null,
    image_tag: "spawnfile/daimon:latest",
    kind: "container" as const,
    runtime_instances: ["daimon-organization"],
    ...unit
  })),
  version: "spawnfile.deployment.v2"
}) as DeploymentRecord;

const inspection = (running: boolean | null) => new Map([["unit-0", {
  containerId: "container-0", drift: [], exists: running !== null, exitCode: null,
  finishedAt: null, identity: null, imageId: null, message: "", restartCount: null,
  running, severity: "ok" as const, startedAt: null, status: null, unitId: "unit-0"
}]]);

const handlersFor = (stdoutByPath: Record<string, string>, running: boolean | null = true) => ({
  createDockerProbeGateway: (() => ({
    exec: async (command: string[]) => {
      const target = command[1]!;
      if (!(target in stdoutByPath)) throw new Error("docker probe exit 1: No such file or directory");
      return { stderr: "", stdout: stdoutByPath[target]! };
    },
    httpGet: async () => ({ body: "", ok: true }),
    inspectUnit: async () => { throw new Error("unused"); }
  })) as never,
  inspectDockerDeployment: (async () => inspection(running)) as never,
  listDeploymentRecords: (async () => [{ path: "/tmp/out/record.json", record: record() }]) as never
});

describe("selectUsageDeployment", () => {
  it("reports a helpful error when nothing is deployed", () => {
    expect(selectUsageDeployment([])).toEqual({ error: expect.stringContaining("No deployment records") });
  });

  it("requires --deployment when several records exist", () => {
    const two = [{ record: record() }, { record: { ...record(), name: "other" } }];
    expect(selectUsageDeployment(two)).toEqual({ error: expect.stringContaining("requires --deployment") });
    expect(selectUsageDeployment(two, "other")).toMatchObject({ name: "other" });
    expect(selectUsageDeployment(two, "absent")).toEqual({ error: expect.stringContaining("Unknown deployment") });
  });
});

describe("collectOrganizationUsage", () => {
  it("reads both ledger generations through the probe gateway", async () => {
    const result = await collectOrganizationUsage({ outputDirectory: "/tmp/out" }, handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: `${line()}\n`,
      [DAIMON_GROK_TURN_USAGE_LEDGER.rotatedFilePath]: `${line({ wake: "rotated" })}\n`
    }));
    expect("error" in result).toBe(false);
    const usage = result as Exclude<typeof result, { error: string }>;
    expect(usage.records.map((entry) => entry.wake).sort()).toEqual(["rotated", "wake-1"]);
    expect(usage.roster.map((entry) => entry.agent)).toEqual(["brass", "cogsworth", "foreman"]);
  });

  it("renders a missing ledger as empty rather than an error", async () => {
    const result = await collectOrganizationUsage({ outputDirectory: "/tmp/out" }, handlersFor({}));
    expect(result).toMatchObject({ records: [], unreadableUnits: [] });
  });

  it("reports a stopped container as unreadable rather than as zero usage", async () => {
    const result = await collectOrganizationUsage({ outputDirectory: "/tmp/out" }, handlersFor({}, false));
    const usage = result as Exclude<typeof result, { error: string }>;
    expect(usage.records).toEqual([]);
    expect(usage.unreadableUnits).toEqual([{ containerRef: "container-0", reason: "stopped", unitId: "unit-0" }]);
  });

  it("reports a rotated generation that overran the read buffer as unreadable, not as zero usage", async () => {
    const result = await collectOrganizationUsage({ outputDirectory: "/tmp/out" }, {
      ...handlersFor({}),
      createDockerProbeGateway: (() => ({
        exec: async (command: string[]) => {
          if (command[1] === DAIMON_GROK_TURN_USAGE_LEDGER.rotatedFilePath) {
            throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            });
          }
          return { stderr: "", stdout: `${line()}\n` };
        },
        httpGet: async () => ({ body: "", ok: true }),
        inspectUnit: async () => { throw new Error("unused"); }
      })) as never
    });
    const usage = result as Exclude<typeof result, { error: string }>;
    expect(usage.records).toHaveLength(1);
    expect(usage.unreadableUnits).toEqual([{
      containerRef: "container-0",
      detail: `${DAIMON_GROK_TURN_USAGE_LEDGER.rotatedFilePath}: stdout maxBuffer length exceeded`,
      reason: "ledger_read_failed",
      unitId: "unit-0"
    }]);
  });
});

describe("spawnfile usage", () => {
  it("renders PARTIAL coverage, an engine rollup, and the lower-bound caveat", async () => {
    const result = await executeUsageCommand("/tmp/project", {}, handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: `${line()}\n${line({ agent: "foreman", wake: "w2", total: 1_400_000, notional_usd: 4.3 })}\n`
    }));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ORG daimon-organization · last 24h · coverage PARTIAL (2 of 3 agents)");
    expect(result.output).toContain("brass");
    expect(result.output).toMatch(/grok\s+\S*2/u);
    expect(result.output).toContain("Counts are a lower bound");
  });

  it("reports a mixed AGY and Grok organization with both engines rolled up", async () => {
    const result = await executeUsageCommand("/tmp/project", {}, handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: [
        line(),
        line({ agent: "foreman", wake: "w2", engine: "agy", input: 44_937, output: 444, cache_read: 0, total: 45_381, notional_usd: 0 })
      ].join("\n") + "\n"
    }));
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/^foreman\s+agy\s/mu);
    expect(result.output).toMatch(/^cogsworth\s+grok\s/mu);
    expect(result.output).toMatch(/^agy\s/mu);
    expect(result.output).toMatch(/^grok\s/mu);
    // AGY's result frame carries no `total_cost_usd`, so its notional column is
    // structurally unknown. Rendering it as `$0.00` would advertise a free turn
    // on a subscription that was in fact spent.
    expect(result.output).toMatch(/^foreman\s+agy\s+\S+\s+45\.4k\s+—/mu);
    expect(result.output).toMatch(/^agy\s+\S*\s*1\s+45\.4k\s+—/mu);
  });

  it("counts an all-zero turn as unknown rather than free", async () => {
    const result = await executeUsageCommand("/tmp/project", {}, handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: `${line({ complete: false, input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 })}\n`
    }));
    expect(result.output).toContain("reported all-zero usage and are counted as unknown, not free");
  });

  it("windows by --since and drops records outside it", async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
    const handlers = handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: `${line({ at: stale })}\n${line({ agent: "foreman", wake: "w2" })}\n`
    });
    const day = await executeUsageCommand("/tmp/project", { json: true }, handlers);
    expect(JSON.parse(day.output!).coverage.agentsReporting).toBe(1);
    const week = await executeUsageCommand("/tmp/project", { json: true, since: "7d" }, handlers);
    expect(JSON.parse(week.output!).coverage.agentsReporting).toBe(2);
  });

  it("filters to one agent and caps the table with --top", async () => {
    const handlers = handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: `${line()}\n${line({ agent: "foreman", wake: "w2" })}\n`
    });
    const one = await executeUsageCommand("/tmp/project", { agent: "foreman", json: true }, handlers);
    expect(JSON.parse(one.output!).byEngine[0].turns).toBe(1);
    const top = await executeUsageCommand("/tmp/project", { top: "1" }, handlers);
    expect(top.output).not.toContain("brass");
  });

  it("emits machine-readable JSON that declares its counts a lower bound", async () => {
    const result = await executeUsageCommand("/tmp/project", { json: true }, handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: `${line()}\n`
    }));
    const parsed = JSON.parse(result.output!);
    expect(parsed).toMatchObject({ version: "spawnfile.usage.v1", deployment: "daimon-organization", lowerBound: true, since: "24h" });
    expect(parsed.coverage).toMatchObject({ agentsReporting: 1, agentsTotal: 3, partial: true });
  });

  it("rejects malformed options without reading anything", async () => {
    const listDeploymentRecords = vi.fn();
    for (const options of [{ since: "soon" }, { by: "team" }, { top: "0" }, { timeout: "later" }]) {
      const result = await executeUsageCommand("/tmp/project", options, { listDeploymentRecords: listDeploymentRecords as never });
      expect(result.exitCode).toBe(2);
      expect(result.error).toMatch(/Invalid/u);
    }
    expect(listDeploymentRecords).not.toHaveBeenCalled();
  });

  it("marks the window PARTIAL and prints an UNREADABLE row when a ledger read fails", async () => {
    // A dead subscription must never be reported as a cheap one: an
    // unreadable generation is UNKNOWN usage, not zero usage.
    const handlers = {
      ...handlersFor({}),
      createDockerProbeGateway: (() => ({
        exec: async (command: string[]) => {
          if (command[1] === DAIMON_GROK_TURN_USAGE_LEDGER.rotatedFilePath) {
            throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stderr: "" });
          }
          return {
            stderr: "",
            stdout: `${line()}\n${line({ agent: "foreman", wake: "w2" })}\n${line({ agent: "brass", wake: "w3" })}\n`
          };
        },
        httpGet: async () => ({ body: "", ok: true }),
        inspectUnit: async () => { throw new Error("unused"); }
      })) as never
    };

    const table = await executeUsageCommand("/tmp/project", {}, handlers);
    expect(table.output).toContain("coverage PARTIAL");
    expect(table.output).toContain("UNREADABLE unit-0 (container-0): ledger read failed");

    const json = await executeUsageCommand("/tmp/project", { json: true }, handlers);
    const parsed = JSON.parse(json.output!);
    expect(parsed.coverage).toMatchObject({ agentsReporting: 3, agentsTotal: 3, partial: true, unreadableUnitCount: 1 });
    expect(parsed.unreadableUnits[0]).toMatchObject({ reason: "ledger_read_failed" });
  });

  it("separates a runtime failure (exit 1) from a usage/input failure (exit 2)", async () => {
    // errorExitCode's contract (specs/SPEC.md §9.1, shared across every
    // command): 2 for usage/input errors, 1 for runtime failures. A Docker
    // read blowing up is not the operator mistyping a flag.
    const runtime = await executeUsageCommand("/tmp/project", {}, {
      listDeploymentRecords: (async () => { throw new Error("docker daemon unreachable"); }) as never
    });
    expect(runtime).toMatchObject({ error: "docker daemon unreachable", exitCode: 1 });

    const usageError = await executeUsageCommand("/tmp/project", {}, {
      listDeploymentRecords: (async () => {
        throw new SpawnfileError("validation_error", "deployment record is malformed");
      }) as never
    });
    expect(usageError).toMatchObject({ error: "deployment record is malformed", exitCode: 2 });
  });

  it("groups by engine when asked", async () => {
    const result = await executeUsageCommand("/tmp/project", { by: "engine" }, handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: `${line()}\n`
    }));
    expect(result.output).not.toContain("cogsworth");
    expect(result.output).toContain("grok");
  });
});

describe("spawnfile usage --exported", () => {
  const exportRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(exportRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  const writeExport = async (generations: Record<string, string>): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-usage-export-"));
    exportRoots.push(root);
    await mkdir(path.join(root, "spawnfile"), { recursive: true });
    await writeFile(path.join(root, "spawnfile", "export-index.json"), JSON.stringify({
      version: "spawnfile.export-index.v1",
      run_id: "run-42",
      deployment: "daimon-organization",
      exported_at: new Date().toISOString(),
      files: []
    }));
    if (Object.keys(generations).length > 0) {
      await mkdir(path.join(root, "raw", "daimon"), { recursive: true });
      for (const [name, content] of Object.entries(generations)) {
        await writeFile(path.join(root, "raw", "daimon", name), content);
      }
    }
    return root;
  };

  const recordsOnly = { listDeploymentRecords: (async () => [{ path: "/tmp/out/record.json", record: record() }]) as never };

  /**
   * The real property is EQUIVALENCE: identical ledger bytes must aggregate to
   * the same answer whether they arrive from `docker exec cat` or from a sealed
   * export. Asserting that directly, rather than hardcoding totals in two
   * places, is what proves the export path reuses the aggregation layer instead
   * of quietly growing a second one that can drift.
   */
  it("aggregates an exported run identically to the same bytes read live", async () => {
    const primary = `${line()}\n${line({ wake: "wake-2", total: 2_000 })}\n`;
    const rotated = `${line({ wake: "rotated", agent: "foreman", total: 900 })}\n`;

    const live = await executeUsageCommand("/tmp/project", { json: true, out: "/tmp/out" }, handlersFor({
      [DAIMON_GROK_TURN_USAGE_LEDGER.filePath]: primary,
      [DAIMON_GROK_TURN_USAGE_LEDGER.rotatedFilePath]: rotated
    }));
    const exported = await executeUsageCommand("/tmp/project", {
      exported: await writeExport({ "usage.jsonl": primary, "usage.jsonl.1": rotated }),
      json: true,
      out: "/tmp/out"
    }, recordsOnly);

    expect(live.exitCode).toBe(0);
    expect(exported.exitCode).toBe(0);
    const stripSource = (output: string) => {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      delete parsed.source;
      return parsed;
    };
    expect(stripSource(exported.output!)).toEqual(stripSource(live.output!));
    // Guard against the equivalence passing because both sides are empty.
    expect((stripSource(live.output!) as { byEngine: unknown[] }).byEngine.length).toBeGreaterThan(0);
  });

  /**
   * `usage.jsonl.1` is the OLDER generation and must be read first.
   *
   * Aggregation is almost entirely order-independent -- sums and counts do not
   * care -- so most assertions here would pass with the generations reversed.
   * The one observable that does care is engine attribution: `groupUsageByAgent`
   * takes an agent's engine from the FIRST record it sees, so an agent that
   * changed engine across a rotation reports the engine it started the window
   * on. Reversing the generations silently reattributes it, which is exactly the
   * plausible-looking wrong answer worth pinning.
   */
  it("orders the rotated generation before the current one", async () => {
    const exported = await executeUsageCommand("/tmp/project", {
      exported: await writeExport({
        "usage.jsonl": `${line({ engine: "agy", wake: "current" })}\n`,
        "usage.jsonl.1": `${line({ engine: "grok", wake: "older" })}\n`
      }),
      json: true,
      out: "/tmp/out"
    }, recordsOnly);

    const byAgent = JSON.parse(exported.output!).byAgent as { agent: string; engine: string | null; turns: number }[];
    const cogsworth = byAgent.find((row) => row.agent === "cogsworth")!;
    expect(cogsworth.turns).toBe(2);
    // The older generation is read first, so the window opens on grok.
    expect(cogsworth.engine).toBe("grok");
  });

  it("reports an export carrying no ledger as unknown, never as zero cost", async () => {
    const result = await executeUsageCommand("/tmp/project", {
      exported: await writeExport({}),
      out: "/tmp/out"
    }, recordsOnly);

    expect(result.exitCode).toBe(0);
    // Absent, not empty-and-complete: coverage must degrade and no dollar
    // figure may be asserted over a ledger nobody read.
    expect(result.output).toContain("coverage PARTIAL");
    expect(result.output).toContain("is not in this export");
    expect(result.output).toContain("no metered turns in this window");
    expect(result.output).not.toMatch(/\$\d/u);
  });

  it("names the source it read so the choice is never left implicit", async () => {
    const root = await writeExport({ "usage.jsonl": `${line()}\n` });
    const exported = await executeUsageCommand("/tmp/project", { exported: root, out: "/tmp/out" }, recordsOnly);
    expect(exported.output).toContain(`source exported ${root}`);

    const live = await executeUsageCommand("/tmp/project", { out: "/tmp/out" }, handlersFor({}));
    expect(live.output).not.toContain("source exported");
  });

  it("rejects a directory that is not a Spawnfile export", async () => {
    const notAnExport = await mkdtemp(path.join(os.tmpdir(), "spawnfile-usage-notexport-"));
    exportRoots.push(notAnExport);
    const result = await executeUsageCommand("/tmp/project", { exported: notAnExport, out: "/tmp/out" }, recordsOnly);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain("Not a Spawnfile export directory");
  });
});
