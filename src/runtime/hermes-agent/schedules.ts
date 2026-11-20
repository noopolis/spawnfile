import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { ContainerTargetPersistentMount, EmittedFile } from "../types.js";
import { hermesBinary } from "./install.js";
import { hermesCronBootstrap } from "./cronBootstrap.js";

const descriptorName = "spawnfile-schedule.json";
const bootstrapName = "spawnfile-cron.py";

interface HermesWakeDescriptor {
  trigger: { schedule: string; timezone?: string };
  job: { prompt: string; workdir: string; deliver: "local"; attach_to_session: false };
}

function scheduleDescriptor(node: ResolvedAgentNode): HermesWakeDescriptor | undefined {
  const schedule = node.schedule;
  if (schedule?.kind !== "cron" || schedule.jitter_seconds) return;
  const job = {
    prompt: schedule.prompt ?? "Run the scheduled Spawnfile task.",
    workdir: "<workspace-path>",
    deliver: "local",
    attach_to_session: false
  } as const;
  const timezone = new Intl.DateTimeFormat("en", { timeZone: schedule.timezone ?? "UTC" })
    .resolvedOptions().timeZone;
  if (timezone.startsWith("+") || timezone.startsWith("-")) return;
  return { trigger: { schedule: schedule.cron, timezone }, job };
}

export function hermesScheduleCapability(node: ResolvedAgentNode) {
  if (!node.schedule) return {};
  if (node.schedule.kind === "disabled") {
    return {
      scheduleOutcome: "supported",
      scheduleMessage: "Disabled schedule emits no wake registration"
    } as const;
  }
  if (!scheduleDescriptor(node)) {
    return {
      scheduleOutcome: "degraded",
      scheduleMessage: node.schedule.jitter_seconds
        ? "Hermes native cron has no jitter policy"
        : node.schedule.kind === "cron"
          ? "Hermes native cron requires a named IANA timezone"
          : "Hermes native intervals run relative to the previous job completion"
    } as const;
  }
  return {
    scheduleOutcome: "supported",
    scheduleMessage: "Hermes gateway runs the native detached wake and saves its output locally"
  } as const;
}

export function hermesScheduleFiles(node: ResolvedAgentNode): EmittedFile[] {
  const descriptor = scheduleDescriptor(node);
  return [
    {
      path: `home/${bootstrapName}`,
      content: `SCHEDULE_ENABLED = ${descriptor ? "True" : "False"}\n${hermesCronBootstrap}`
    },
    ...(descriptor ? [{
      path: `home/${descriptorName}`,
      content: `${JSON.stringify(descriptor, null, 2)}\n`
    }] : [])
  ];
}

export function hermesCronMount(slug: string): ContainerTargetPersistentMount {
  return {
    id: `hermes-agent-${slug}-cron`,
    mountPath: "<instance-root>/hermes/cron",
    reason: "Hermes Agent native cron state"
  };
}

export const hermesCronGatewayCommand = [
  "/opt/hermes/.venv/bin/python", `<home-path>/${bootstrapName}`, `<home-path>/${descriptorName}`,
  hermesBinary, "gateway", "run", "--no-supervise", "--external-supervisor"
];
