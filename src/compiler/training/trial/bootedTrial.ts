import path from "node:path";

import type { DaimonControlCall, DaimonControlTarget } from "../../../runtime/daimon/control.js";
import { maskSecrets, SpawnfileError } from "../../../shared/index.js";
import type { BootedTrial, TrialWake } from "./boot.js";
import type { TrialDocker } from "./docker.js";
import { agentExecutionError, agentSettled, readLedger, readRequestLedger, readTranscript, requestUsage } from "./trialReads.js";
import { renderMomentWake, type TrainingMoment } from "../moments.js";

const WAKE_VERSION = "noopolis.daimon.wake.v2";
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ABSENT = "__spawnfile_trial_output_absent__";

/** A booted trial organization: wakes through Daimon's control API, reads from its workspace. */
export const createBootedTrial = (input: {
  agentId: string; call: DaimonControlCall; container: string; docker: TrialDocker; moment: TrainingMoment | undefined;
  secrets: readonly string[]; sessionsPath: string | null; target: DaimonControlTarget; teardown: () => Promise<string | null>; workspace: string | null;
}): BootedTrial => {
  let seenRows = 0;
  let seenRequests = 0;
  return {
    container: input.container,
    teardown: input.teardown,
    scanCredentials: async () => {
      const found = await input.docker(["exec", input.container, "find", "/", "-xdev", "(", "-name", "auth.json", "-o", "-name", "*token*", "-o", "-name", "*bootstrap-auth*", ")",
        "-not", "-path", "/proc/*", "-not", "-path", "/sys/*", "-not", "-path", "/usr/*", "-not", "-path", "/opt/spawnfile/runtime-installs/*"], { timeoutMs: 60_000 }).catch((error: Error) => error.message);
      return found.split("\n").filter(Boolean);
    },
    read: async (file) => {
      if (input.workspace === null || file.startsWith("/") || file.split("/").some((part) => !part || part === "." || part === "..")) return null;
      const text = await input.docker(["exec", input.container, "sh", "-c",
        'if [ -f "$1" ]; then head -c "$2" -- "$1"; else printf "%s" "$3"; fi', "sh", path.posix.join(input.workspace, file), String(MAX_OUTPUT_BYTES), ABSENT]);
      return text === ABSENT ? null : text;
    },
    wake: async (text, options) => {
      // A moment's wake arrives as production Moltnet delivers a room message: kind message at its own instant.
      const event = input.moment
        ? { version: WAKE_VERSION, kind: "message", text: renderMomentWake(input.moment.wake), occurred_at: input.moment.at }
        : { version: WAKE_VERSION, kind: "manual", text, occurred_at: new Date().toISOString() };
      const body = { agent_id: input.agentId, delivery_id: options.deliveryId, event };
      const accepted = await input.call(input.target, "POST", "/v2/wakes", body);
      const acceptance = JSON.parse(accepted.body) as { state?: string; acceptance_id?: string; code?: string };
      if (accepted.status !== 202 || acceptance.state !== "accepted" || !acceptance.acceptance_id) {
        throw new SpawnfileError("runtime_error", `trial wake was not accepted (HTTP ${accepted.status}${acceptance.code ? `, ${acceptance.code}` : ""})`);
      }
      const id = acceptance.acceptance_id;
      const startedMs = Date.now() - 5_000;
      let receipt: { state?: string; execution_id?: string; code?: string; text?: string; deferred?: boolean } = {};
      const deadline = Date.now() + options.timeoutMs;
      // The subject may end its turn by deferring the delivery: Daimon returns it to `accepted`, marked deferred,
      // to wait for input a trial never sends. That ends the trial's turn as surely as completing it.
      const ended = (): boolean => TERMINAL.has(receipt.state ?? "") || (receipt.state === "accepted" && receipt.deferred === true);
      while (!ended() && Date.now() < deadline && !options.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = await input.call(input.target, "GET", `/v2/wake-receipts/${id}`);
        if (response.status === 200) receipt = JSON.parse(response.body) as typeof receipt;
      }
      // A delivery can be disposed mid-turn (attention's disposition tool), so its receipt ends before its turn
      // does; the turn's usage and transcript land when the execution ends, which only the activity shows. A
      // deferral clears the receipt's execution id, so the execution is found by the delivery it carries.
      const execution = receipt.execution_id;
      while (Date.now() < deadline && !options.signal?.aborted) {
        const activity = await input.call(input.target, "GET", "/v2/activity");
        const executions = activity.status === 200 ? (JSON.parse(activity.body) as { executions?: { execution_id?: string; delivery_ids?: string[] }[] }).executions ?? [] : [];
        if (!executions.some((entry) => entry.execution_id === execution || entry.delivery_ids?.includes(options.deliveryId))) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      // A turn may hand its work to a fresh turn of its own (Daimon's `daimon_continue`), as production would run
      // it: the trial's wake lasts until the agent's queue settles, so a write-then-verify filing is graded whole.
      while (Date.now() < deadline && !options.signal?.aborted && !(await agentSettled(input.call, input.target, input.agentId))) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      // Daimon defers a delivery whose execution failed twice, and a delivery still open at the deadline may be
      // on the retry of a failed execution; only the agent's availability names that failure.
      const reported = receipt.state === "failed" ? receipt.text || null
        : TERMINAL.has(receipt.state ?? "") ? null : await agentExecutionError(input.call, input.target, input.agentId);
      const failure = reported === null ? null : maskSecrets(reported, input.secrets);
      const rows = await readLedger(input.docker, input.container);
      const requests = await readRequestLedger(input.docker, input.container);
      const fresh = requests.slice(seenRequests).filter((row) => row.agent === input.agentId);
      const turnUsage = rows.slice(seenRows).filter((row) => row.agent === input.agentId);
      const usage = turnUsage.length ? turnUsage : requestUsage(fresh, input.agentId);
      seenRows = rows.length;
      seenRequests = requests.length;
      return {
        acceptanceId: id, code: receipt.code ?? null, executionId: receipt.execution_id ?? null, usage,
        state: TERMINAL.has(receipt.state ?? "") ? receipt.state as TrialWake["state"] : ended() ? "deferred" : "timeout",
        text: receipt.text ?? "",
        failure,
        requestToolCalls: fresh.filter((row) => row.wake === options.deliveryId).map((row) => row.tool_calls ?? null),
        transcript: input.sessionsPath === null ? null : await readTranscript(input.docker, input.container, input.sessionsPath, startedMs)
      };
    }
  };
};
