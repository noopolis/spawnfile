import { join } from 'node:path';
import { nativeTrialArtifactsRoot } from './receipt/index.js';
import { admittedNativeEvidence, type NativeTurnEvidence } from './outcome.js';
import { boundedTransportCall, requestTransportDelivery, transportTerminalBinding, verifyPreparedTransport,
  type NativeExecutionHandle, type NativeTransportDelivery, type PreparedTransportDelivery } from './transport/index.js';
import { startOwnedChild, type NativeChildExecution } from './child/index.js';
import { nextExternalInput, weakestNativeCoverage, type NativeExternalInputs } from './external.js';
import type { SubjectAdapter, SubjectTurnResult } from '../../contracts/execution.js';
import { MAX_EXTERNAL_DELIVERIES, type TerminalEvidence, type DeliveryControls } from './worker/index.js';
import { dockerCommand, workerRequest, type DockerCommand } from './container/index.js';
import { startOwnedContainer } from './container/index.js';
import { loadNativeLaunch } from './container/index.js';
import { createNativeObserver } from './observations.js';
import { readSealedBrokerRequests, readSealedBrokerSeal, readSealedBrokerUsage, type SealedBrokerUsageOptions } from './sealed-usage.js';
import { nativeAdmission, unknownNativeAdmission } from './admission.js';

export interface NativeAdapterOptions { timeoutMs?: number; startupMs?: number; docker?: DockerCommand; execution?: NativeChildExecution; externalInputs?: NativeExternalInputs;
  /** Reserve the caller-owned transport source; the adapter publishes after the worker arms it. */
  transportDelivery?: NativeTransportDelivery;
  /** How long a failed turn waits for the broker to seal its spend before reporting absence. */
  sealedUsage?: SealedBrokerUsageOptions }

export function createDaimonNativeAdapter(options: NativeAdapterOptions = {}): SubjectAdapter {
  const timeoutMs = options.timeoutMs ?? 900_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 86_400_000) throw new Error('Invalid native adapter deadline');
  if (options.execution && options.externalInputs) throw new Error('Child execution requires execution.externalInputs, not Docker externalInputs');
  const sealedUsage = options.sealedUsage;
  const execution = options.execution;
  if (execution && execution.kind !== 'child-process') throw new Error('Unsupported native execution mode');
  const childExternal = execution?.externalInputs ? { ...execution.externalInputs } : undefined;
  const dockerExternal = options.externalInputs ? { ...options.externalInputs } : undefined;
  const external = childExternal ?? dockerExternal;
  if (external && (!Number.isSafeInteger(external.maxDeliveries) || external.maxDeliveries < 1 || external.maxDeliveries > MAX_EXTERNAL_DELIVERIES || typeof external.next !== 'function')) throw new Error('Invalid external input policy');
  if (options.execution && options.docker) throw new Error('Select one native execution transport');
  if (options.transportDelivery && typeof options.transportDelivery.prepare !== 'function') throw new Error('Invalid transport delivery provider');
  const docker = options.docker ?? dockerCommand();
  return {
    id: 'daimon-native',
    capabilities: { toolTrace: 'partial', liveObservations: true, cancellation: 'native-handle', multiTurn: false,
      resources: ['instructions', 'native-skills', 'supporting-files'], readIsolation: 'declared-paths', protectedPaths: true,
      isolation: execution ? 'Fresh worker child in shared caller container; exact native sandbox protects declared paths' :
        'Fresh local Linux container; canonical native sandbox denies /run and runtime credentials; evaluator files excluded from mounts' },
    async start(input) {
      if (input.signal?.aborted) throw new Error('Native subject start aborted');
      const launch = await loadNativeLaunch(input, !!execution);
      if (launch.delivery === 'transport' && !options.transportDelivery) throw new Error('Transport delivery mode requires a transport delivery provider');
      const deadline = Date.now() + timeoutMs;
      const container: NativeExecutionHandle = execution
        ? await startOwnedChild(execution, launch, input.trialId, timeoutMs, input.signal, options.startupMs, input.protectedPaths)
        : await startOwnedContainer(docker, launch, input.trialId, timeoutMs, input.signal, options.startupMs).then(owned => ({
          ...owned, request: <T>(path: Parameters<NativeExecutionHandle['request']>[0], body?: unknown, ms?: number, signal?: AbortSignal) =>
            workerRequest<T>(docker, owned.name, path, body, ms, signal, launch.host.port),
        }));
      const observer = createNativeObserver(input, launch.projections.find(row => row.role === 'home')!.source, launch.agent.id, launch.agent.engine);
      const evidence: NativeTurnEvidence = { schema: 'paideia.daimon-native.evidence.v1', wakes: [] };
      const admittedDeliveries = new Set<string>();
      let attributionInvalid = false;
      let ordinal = 0;
      let used = false;
      let stopped = false;
      const sessionCancellation = new AbortController();
      const stop = async (reason: string) => { stopped = true; sessionCancellation.abort(); return container.stop(reason); };
      const deliver = async (turn: {id: string; text: string}, signal: AbortSignal | undefined, controls?: DeliveryControls, observedWakeId = turn.id,
        transport?: PreparedTransportDelivery) => {
          if (stopped || signal?.aborted || input.signal?.aborted) throw new Error('Native subject cancelled before delivery');
          const signals = [input.signal, signal].filter((value): value is AbortSignal => value !== undefined);
          const cancelled = new AbortController();
          const abort = (): void => { cancelled.abort(); if (!stopped) void stop('Native subject aborted'); };
          for (const source of signals) source.addEventListener('abort', abort, { once: true });
          if (signals.some(source => source.aborted)) abort();
          let done = false;
          let terminal: TerminalEvidence | undefined;
          let failure: unknown;
          const deliveryOrdinal = ++ordinal;
          const body = { wakeId: turn.id, text: turn.text, ...(controls ? { controls } : {}) };
          const response = (transport
            ? requestTransportDelivery(container.request, { ...body, source: transport.source }, transport, deadline, cancelled.signal)
            : container.request<TerminalEvidence>('/trial/run', body, Math.max(1, deadline - Date.now()) + 8000, cancelled.signal))
            .then(value => { terminal = value; }, error => { failure = error; }).finally(() => { done = true; });
          try {
            while (!done) {
              await observer.checkpoint(observedWakeId);
              await Promise.race([response, new Promise(resolve => setTimeout(resolve, 200))]);
            }
            if (failure) throw failure;
            if (!terminal || terminal.schema !== 'paideia.daimon-native.trial.v1' || terminal.trialId !== input.trialId ||
                terminal.wakeId !== turn.id || terminal.agentId !== launch.agent.id || terminal.model !== launch.agent.model ||
                terminal.configSha256 !== launch.configSha256) {
              if (terminal) attributionInvalid = true;
              throw new Error('Native terminal evidence identity mismatch');
            }
            const binding = transport ? transportTerminalBinding(terminal, transport.source) : 'bound';
            if (binding === 'conflict') {
              attributionInvalid = true;
              throw new Error('Native transport terminal evidence identity mismatch');
            }
            let admitted: NativeTurnEvidence['wakes'][number] | undefined;
            try { admitted = admittedNativeEvidence(terminal, launch, input.trialId, turn.id, deliveryOrdinal,
              join(nativeTrialArtifactsRoot(launch, input.trialId), 'evidence.json'), transport?.source, admittedDeliveries);
            } catch (error) { attributionInvalid = true; throw error; }
            if (admitted) evidence.wakes.push(admitted);
            if (terminal.blocked && terminal.status !== 'failed') throw new Error('Blocked native terminal cannot claim completion');
            const admission = terminal.status === 'failed' && !terminal.blocked ? nativeAdmission(terminal) : undefined;
            await observer.checkpoint(observedWakeId);
            // No execution has no usage/output to publish. Retain its admission
            // evidence in the turn before collectors demand an execution binding.
            const usage = admission && Object.values(admission).every(value => value === 0)
              ? null : await observer.terminal(observedWakeId, terminal);
            // The blocked receipt travels with the verified terminal evidence: the trace
            // closed, the delivery stayed accepted and deferred, and the identity checks
            // above matched. The caller needs that apart from the bare `failed` status.
            return { result: { status: terminal.status, text: '', usage, error: terminal.error, coverage: terminal.coverage,
              ...(admission ? { admission } : {}),
              ...(terminal.blocked ? { blocked: terminal.blocked } : {}) } as SubjectTurnResult, terminal, verified: binding === 'bound' };
          } catch (error) {
            const wasCancelled = stopped || signals.some(source => source.aborted);
            cancelled.abort();
            const receipt = await stop('Native subject execution failed');
            // The worker's reply was the only route usage normally takes here,
            // and it never came — but a wake that fails spends the same money
            // as one that publishes, and the broker sealed what its own proxy
            // measured. Read that rather than reporting a zero nobody measured.
            // The broker's own two ledgers, read on one bounded wait: what the
            // turn spent, and — the only record that can tell a provider
            // request issued and never answered from one never issued at all —
            // when each request started and whether it ended.
            // And the sealed terminal record itself, which a hung turn's HTTP
            // reply can never carry: the failure code, the worker's redacted
            // last words, and the MCP tool call it was still blocked on.
            const [sealed, requests, seal] = await Promise.all([
              readSealedBrokerUsage(launch, sealedUsage), readSealedBrokerRequests(launch, sealedUsage),
              readSealedBrokerSeal(launch, sealedUsage),
            ]);
            const usage = await observer.sealedUsage(observedWakeId, sealed.rows);
            if (requests) await observer.brokerRequests(observedWakeId, requests);
            if (seal) await observer.brokerSeal(observedWakeId, seal);
            // Whatever the worker said before it stopped answering, redacted.
            const record = container.diagnostic?.();
            if (record) await observer.childDiagnostic(observedWakeId, record);
            return { result: { status: wasCancelled ? 'cancelled' as const : 'failed' as const,
              admission: unknownNativeAdmission(),
              text: '', usage, error: String(error), stop: receipt,
              coverage: [{ channel: 'tools' as const, completeness: 'partial' as const, ordering: 'none' as const },
                { channel: 'output' as const, completeness: 'absent' as const, ordering: 'none' as const },
                // Measured, but never complete: the execution it belongs to never closed.
                { channel: 'usage' as const, completeness: usage ? 'partial' as const : 'absent' as const,
                  ordering: usage ? 'source' as const : 'none' as const }] } as SubjectTurnResult, terminal, verified: false };
          } finally { for (const source of signals) source.removeEventListener('abort', abort); }
      };
      return { stop, async run(turn, signal) {
        const result = await run(turn, signal);
        return { ...result, ...(!attributionInvalid && evidence.wakes.length ? { evidence: { adapterId: 'daimon-native', payload: structuredClone(evidence) } } : {}) };
      } };
      async function run(turn: { id: string; text: string }, signal?: AbortSignal): Promise<SubjectTurnResult> {
        if (used || stopped) throw new Error('Native Daimon session permits one delivery');
        used = true;
        const combined = AbortSignal.any([sessionCancellation.signal, input.signal, signal].filter((value): value is AbortSignal => value !== undefined));
        const coverages: SubjectTurnResult['coverage'][] = [];
        const ids = new Set([turn.id]);
        let current = turn;
        let transport: PreparedTransportDelivery | undefined;
        let controls: DeliveryControls | undefined = external ? { maxExternalDeliveries: external.maxDeliveries } : undefined;
        try {
          if (launch.delivery === 'transport') {
            transport = await boundedTransportCall(bound => options.transportDelivery!.prepare({ trialId: input.trialId, turnId: turn.id,
              text: turn.text, launch, executionId: container.name }, bound), deadline, combined);
            verifyPreparedTransport(transport);
          }
          for (let ordinal = 0; ; ordinal++) {
            const { result, terminal, verified } = await deliver(current, combined, controls, turn.id, transport);
            coverages.push(result.coverage);
            // A cancelled wake never carries the deferral: cancellation is the machine's outcome.
            if (verified && stopped) return { ...result, status: 'cancelled', blocked: undefined, usage: observer.usage(),
              coverage: weakestNativeCoverage(coverages), stop: await stop('Native subject stopped after verified wake') };
            if (!verified || !external || terminal?.blocked !== 'awaiting-external-input') return { ...result, usage: observer.usage(), coverage: weakestNativeCoverage(coverages) };
            if (ordinal >= external.maxDeliveries) return { ...result, status: 'failed', usage: observer.usage(), coverage: weakestNativeCoverage(coverages), stop: await stop('External input delivery budget exhausted') };
            const common = { trialId: input.trialId, turnId: turn.id, launch, terminal };
            const next = execution
              ? await nextExternalInput(childExternal!, { ...common, executionId: container.name }, deadline, combined)
              : await nextExternalInput(dockerExternal!, { ...common, containerName: container.name }, deadline, combined);
            combined.throwIfAborted();
            if (!next) return { ...result, status: 'failed', usage: observer.usage(), coverage: weakestNativeCoverage(coverages), stop: await stop('No matching external input') };
            if (launch.delivery === 'transport' && !next.transport) throw new Error('Transport continuation requires a declared transport delivery');
            if (launch.delivery !== 'transport' && next.transport) throw new Error('Direct delivery cannot publish a transport continuation');
            if (ids.has(next.id)) throw new Error('External input delivery ID was reused');
            ids.add(next.id);
            await observer.externalInput(turn.id, next);
            current = { id: next.id, text: next.text };
            controls = { source: next.source };
            transport = next.transport;
          }
        } catch (error) {
          const wasCancelled = combined.aborted;
          const receipt = await stop('External input continuation failed');
          return { status: wasCancelled ? 'cancelled' : 'failed', text: '', usage: observer.usage(), error: String(error), stop: receipt,
            admission: unknownNativeAdmission(),
            coverage: weakestNativeCoverage(coverages) };
        }
      }
    },
  };
}
