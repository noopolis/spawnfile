import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import {
  hermesCronGatewayCommand, hermesCronMount, hermesScheduleCapability, hermesScheduleFiles
} from "./schedules.js";

const node: ResolvedAgentNode = {
  kind: "agent", name: "Pilot", source: "agent.yml", description: "", env: {},
  execution: undefined, policyMode: null, policyOnDegrade: null, runtime: { name: "hermes-agent", options: {} },
  docs: [], skills: [], secrets: [], mcpServers: [], subagents: []
};

const descriptor = (agent: ResolvedAgentNode) =>
  hermesScheduleFiles(agent).find(file => file.path === "home/spawnfile-schedule.json");

describe("Hermes native schedules", () => {
  it("compiles a detached wake with a named timezone, zero jitter and the authored prompt", () => {
    const agent: ResolvedAgentNode = { ...node, schedule: {
      kind: "cron", cron: "5 9 * * 1", timezone: "Europe/Berlin", jitter_seconds: 0,
      prompt: "Check the local status."
    } };
    expect(JSON.parse(descriptor(agent)!.content)).toEqual({
      trigger: { schedule: "5 9 * * 1", timezone: "Europe/Berlin" },
      job: { prompt: "Check the local status.", workdir: "<workspace-path>", deliver: "local", attach_to_session: false }
    });
    expect(hermesScheduleCapability(agent).scheduleOutcome).toBe("supported");
    expect(hermesScheduleFiles(agent)[0]?.content).toMatch(/^SCHEDULE_ENABLED = True/u);
    expect(hermesCronGatewayCommand).toEqual([
      "/opt/hermes/.venv/bin/python", "<home-path>/spawnfile-cron.py", "<home-path>/spawnfile-schedule.json",
      "/opt/hermes/.venv/bin/hermes", "gateway", "run", "--no-supervise", "--external-supervisor"
    ]);
    expect(hermesCronMount("pilot")).toMatchObject({
      id: "hermes-agent-pilot-cron", mountPath: "<instance-root>/hermes/cron"
    });
  });

  it("defaults the wake prompt and timezone", () => {
    const agent: ResolvedAgentNode = { ...node, schedule: { kind: "cron", cron: "0 * * * *" } };
    expect(JSON.parse(descriptor(agent)!.content)).toMatchObject({
      trigger: { timezone: "UTC" }, job: { prompt: "Run the scheduled Spawnfile task." }
    });
  });

  it.each<NonNullable<ResolvedAgentNode["schedule"]>>([
    { kind: "every", every: "15m" },
    { kind: "every", every: "30s" },
    { kind: "cron", cron: "0 * * * *", jitter_seconds: 1 },
    { kind: "cron", cron: "0 * * * *", timezone: "+01:00" }
  ])("reports an unrepresentable wake as degraded and emits no trigger for %j", schedule => {
    const agent = { ...node, schedule };
    expect(descriptor(agent)).toBeUndefined();
    expect(hermesScheduleCapability(agent).scheduleOutcome).toBe("degraded");
  });

  it("keeps the cleanup bootstrap for disabled or removed schedules with no wake registration", () => {
    const disabled: ResolvedAgentNode = { ...node, schedule: { kind: "disabled" } };
    expect(hermesScheduleFiles(disabled).map(file => file.path)).toEqual(["home/spawnfile-cron.py"]);
    expect(hermesScheduleFiles(disabled)[0]?.content).toMatch(/^SCHEDULE_ENABLED = False/u);
    expect(hermesScheduleFiles(node)).toEqual(hermesScheduleFiles(disabled));
    expect(hermesScheduleCapability(disabled).scheduleOutcome).toBe("supported");
    expect(hermesScheduleCapability(node)).toEqual({});
  });
});
