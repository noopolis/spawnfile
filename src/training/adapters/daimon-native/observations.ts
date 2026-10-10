import type { NativeExternalInput } from './external.js';
import type { Observation, SubjectStart, SubjectStartupDiagnostic, Usage } from '../../contracts/execution.js';
import type { BrokerRequestLedger, BrokerSealLedger } from './sealed-usage.js';
import { readNativeTranscript } from './transcript.js';
import { plausibleNotionalUsd, readToolReceipts } from './worker/index.js';
import type { NativeGrokUsage, NativeUsage, TerminalEvidence } from './worker/index.js';

export function createNativeObserver(input: SubjectStart, runtimeHome: string, agentId: string, engine: 'codex' | 'grok' = 'codex') {
  let seq = 0;
  const accounted = new Map<string, string>();
  const seen = new Set<string>();
  const emit = async (wakeId: string, value: Omit<Observation, 'id' | 'source' | 'seq' | 'timestamp' | 'trialId' | 'wakeId'>,
    timestamp = new Date().toISOString()): Promise<void> => {
    seq++;
    await input.onObservation({ id: `${input.trialId}:native:${seq}`, source: 'daimon.native-evidence', seq,
      timestamp, trialId: input.trialId, wakeId, ...value });
  };
  return {
    async externalInput(wakeId: string, value: NativeExternalInput): Promise<void> {
      await emit(wakeId, { type: 'input', text: value.text, native: { schema: 'paideia.external-input.v1', deliveryId: value.id, source: value.source } });
    },
    async checkpoint(wakeId: string): Promise<void> {
      for (const row of await readToolReceipts(runtimeHome, agentId, engine)) {
        const callId = String(row.delivery_id);
        if (seen.has(callId)) continue;
        seen.add(callId);
        await emit(wakeId, { type: 'tool.complete', callId,
          tool: row.kind === 'moltnet' ? 'moltnet_send' : `mcp_${String(row.server)}_${String(row.tool)}`,
          result: row.kind === 'moltnet' ? { message_id: row.message_id } : row.result ?? row.error,
          success: row.kind === 'moltnet' || row.is_error === false, native: row }, String(row.at));
      }
    },
    /**
     * Why an owned worker stopped answering, redacted by the same rules the
     * startup path uses and published as a `diagnostic` — never output, a
     * captured call or a judge input. It is the only account of a mid-turn
     * death that outlives the container: the full capture stays in the control
     * root, which a training slot puts on tmpfs.
     */
    async childDiagnostic(wakeId: string, record: SubjectStartupDiagnostic): Promise<void> {
      try { await emit(wakeId, { type: 'diagnostic', text: record.reason, native: record }); } catch { /* never fails an already-failed turn */ }
    },
    /**
     * Spend recovered from the broker's sealed ledger when no terminal evidence
     * arrived. It publishes as an ordinary `usage` observation so a failed
     * trial's cost is visible where a completed one's is, and carries the rows
     * it was read from rather than only their sum. A publish fault here is
     * swallowed: this already runs on a failed turn, and instrumentation must
     * never replace a diagnosable failure with a confusing one.
     */
    async sealedUsage(wakeId: string, usage: Usage, rows: readonly NativeGrokUsage[]): Promise<void> {
      try { await emit(wakeId, { type: 'usage', usage, native: rows }); } catch { /* never fails an already-failed turn */ }
    },
    /**
     * The broker's per-request timings for a turn that never reported one.
     *
     * Operator-only, like the records beside it: a `diagnostic` so it can never
     * become output, a captured call, a judge input or a viewer projection. It
     * says whether the last request was issued and left unanswered or never
     * issued at all, which the published event stream otherwise cannot tell
     * apart, and it is timings and counts only. A publish fault is swallowed:
     * this already runs on a failed turn.
     */
    async brokerRequests(wakeId: string, ledger: BrokerRequestLedger): Promise<void> {
      const text = ledger.outcome === 'read'
        ? `Broker request ledger: ${ledger.read} requests, ${ledger.open} unanswered`
        : `Broker request ledger unreadable: ${ledger.failure}`;
      try { await emit(wakeId, { type: 'diagnostic', text, native: ledger }); } catch { /* never fails an already-failed turn */ }
    },
    /**
     * The broker's own sealed account of a turn that never answered.
     *
     * Operator-only, like every record beside it: a `diagnostic`, so it can
     * never become output, a captured call, a judge input or a viewer
     * projection. Its headline is the one fact six live hangs could not
     * produce — the tool call the worker was still blocked on, and for how
     * long. A turn the facade never observed says so by having no `mcp` member
     * at all, and is never rendered as "no outstanding calls". A publish fault
     * is swallowed: this already runs on a failed turn.
     */
    async brokerSeal(wakeId: string, ledger: BrokerSealLedger): Promise<void> {
      const text = ledger.outcome !== 'read'
        ? `Broker turn seal unreadable: ${ledger.failure}`
        : ((): string => {
          const last = ledger.rows[ledger.rows.length - 1];
          const blocked = ledger.rows.flatMap(row => row.mcp?.outstanding ?? []).map(call => `${call.name}@${call.outstandingMs}ms`);
          const observed = ledger.rows.some(row => row.mcp !== undefined);
          const mcp = blocked.length ? `blocked on ${blocked.join(', ')}` : observed ? 'no outstanding MCP call' : 'no MCP observation';
          // The other channel the worker can be idle on: a GET SSE tunnel still
          // open when the turn died, with its age and whether the mount ever
          // pushed through it. A row that never observed tunnels says nothing
          // here rather than reporting a zero nobody measured.
          const tunnels = ledger.rows.flatMap(row => row.mcp?.tunnels === undefined ? [] : [row.mcp.tunnels]);
          const open = tunnels.flatMap(tunnel => tunnel.open).map(tunnel => `${tunnel.openMs}ms/${tunnel.delivered ? 'delivered' : 'silent'}`);
          const get = !tunnels.length ? '' : open.length
            ? `, GET tunnel open ${open.join(', ')}`
            : `, GET tunnels ${tunnels.reduce((total, tunnel) => total + tunnel.closed, 0)}/${tunnels.reduce((total, tunnel) => total + tunnel.opened, 0)} closed`;
          return `Broker turn seal: ${last?.outcome ?? 'unknown'}${last?.code ? `/${last.code}` : ''}, ${mcp}${get}`;
        })();
      try { await emit(wakeId, { type: 'diagnostic', text, native: ledger }); } catch { /* never fails an already-failed turn */ }
    },
    async terminal(wakeId: string, result: TerminalEvidence): Promise<Usage | null> {
      const rows = result.native.accounting?.usage.filter(row => {
        const key = `${row.engine}:${row.wake}`;
        const bytes = JSON.stringify(row);
        const prior = accounted.get(key);
        if (prior !== undefined && prior !== bytes) throw new Error('Conflicting native trial usage execution');
        if (prior !== undefined) return false;
        accounted.set(key, bytes);
        return true;
      }) ?? result.native.usage;
      const usage = aggregateUsage(rows);
      if (usage) await emit(wakeId, { type: 'usage', usage, native: rows }, result.completedAt);
      await emit(wakeId, { type: 'diagnostic', text: `Native execution ${result.status}`, native: result }, result.completedAt);
      // Operator-only, and a diagnostic on purpose: the wake text and the reply
      // must never become this trial's output, a captured call or a judge input.
      // A transcript the engine never wrote, or a runtime home already recycled,
      // is silence rather than an empty capture that reads like evidence.
      if (engine === 'grok') {
        // Observed usage is the metered record of real spend; a diagnostic read
        // of the engine's own transcript must never be able to fail the turn
        // that produced it. Its failure is itself published.
        let transcript: Awaited<ReturnType<typeof readNativeTranscript>>;
        let failure: string | undefined;
        // The trace this frame NAMES, never whichever one leads the list: a trial
        // that defers publishes a frame per wake, and reading another wake's trace
        // here would caption this wake's transcript with that wake's digest.
        try { transcript = await readNativeTranscript(runtimeHome, result.native.traces.find(row => row.turn_id === result.executionId)); }
        catch (error) { failure = error instanceof Error ? error.message : String(error); }
        if (transcript) {
          await emit(wakeId, { type: 'diagnostic', text: 'Native engine transcript captured', native: transcript }, result.completedAt);
        } else if (failure) {
          await emit(wakeId, { type: 'diagnostic', text: `Native engine transcript capture failed: ${failure}` }, result.completedAt);
        }
      }
      return usage;
    },
  };
}

export function aggregateUsage(rows: NativeUsage[]): Usage | null {
  if (!rows.length) return null;
  const sum = (values: number[]): number => {
    const value = values.reduce((total, item) => total + item, 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Native token aggregate is invalid');
    return value;
  };
  const grok = rows.filter((row): row is NativeGrokUsage => row.engine === 'grok');
  if (!grok.length) {
    return { inputTokens: sum(rows.map(row => row.input)), cachedInputTokens: sum(rows.map(row => row.cache_read)), outputTokens: sum(rows.map(row => row.output)),
      reasoningTokens: null, source: 'noopolis.daimon.turn-usage.v1' };
  }
  if (grok.length !== rows.length) throw new Error('Native usage mixes engines');
  // Grok buckets are disjoint; Paideia's inputTokens counts every prompt-side token, with reads and writes as subsets.
  if (!grok.every(row => plausibleNotionalUsd(row.notional_usd))) throw new Error('Native notional USD is outside its per-turn plausibility bound');
  const notionalUsd = grok.reduce((total, row) => total + row.notional_usd, 0);
  return { inputTokens: sum(grok.flatMap(row => [row.input, row.cache_read, row.cache_write])), cachedInputTokens: sum(grok.map(row => row.cache_read)),
    cacheWriteInputTokens: sum(grok.map(row => row.cache_write)), outputTokens: sum(grok.map(row => row.output)), reasoningTokens: null,
    notionalUsd, source: 'noopolis.daimon.turn-usage.v1' };
}
