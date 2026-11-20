import type { TrialDocker } from "../../../../compiler/training/trial/index.js";
import type { UsageRequestRecord } from "../../../index.js";
import { CODEX_THREAD, nativeIdentifier, nativeTimestamp, readCodexToolEvidence, type NativeToolEvent } from "./codexToolEvidence.js";

interface WakeIdentity {
  agent: string;
  wakeIds: ReadonlySet<string>;
  since: number;
  until: number;
  secrets: readonly string[];
}

const MAX_REQUESTS = 256;
const MAX_TOOLS_PER_REQUEST = 32;

function requestEvidence(rows: readonly UsageRequestRecord[], identity: WakeIdentity): NativeToolEvent[] {
  const events = new Map<string, NativeToolEvent>();
  for (const row of rows) {
    if ((row.engine !== "agy" && row.engine !== "grok") || !row.tool_calls?.length || row.request >= row.requests) continue;
    if (row.tool_calls.length > MAX_TOOLS_PER_REQUEST || !row.tool_calls.every(name => nativeIdentifier(name, identity.secrets))) continue;
    const source = `daimon:${row.engine}:request-ledger:${row.turn ?? `${row.wake}:${row.at}`}`;
    const id = `${source}:${row.request}`;
    if (events.has(id)) return [];
    events.set(id, { id, source, seq: row.request, type: "tool.request", timestamp: row.at, args: { tools: row.tool_calls } });
  }
  return [...events.values()];
}

export async function wakeToolEvidence(docker: TrialDocker, container: string, sessionsPath: string | null,
  ledger: readonly UsageRequestRecord[], identity: WakeIdentity): Promise<NativeToolEvent[]> {
  const scoped = ledger.filter(row => row.agent === identity.agent && identity.wakeIds.has(row.wake)
    && nativeTimestamp(row.at) && Date.parse(row.at) >= identity.since && Date.parse(row.at) <= identity.until);
  if (scoped.length > MAX_REQUESTS || new Set(scoped.map(row => row.engine)).size > 1) return [];
  const first = scoped[0];
  if (!first || first.engine !== "codex") return requestEvidence(scoped, identity);
  const { thread, at } = first;
  if (sessionsPath === null || !thread || !CODEX_THREAD.test(thread)) return [];

  // The writer appends one complete, indexed batch from the wake's fresh Codex thread.
  if (first.requests !== scoped.length || !scoped.every((row, index) =>
    row.thread === thread && row.wake === first.wake && row.at === at && row.request === index && row.requests === first.requests)) return [];
  if (ledger.some(row => row.thread === thread && !scoped.includes(row))) return [];
  return readCodexToolEvidence(docker, container, sessionsPath,
    { thread, since: identity.since, recordedAt: Date.parse(at), secrets: identity.secrets });
}
