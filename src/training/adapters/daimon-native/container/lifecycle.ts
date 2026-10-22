import { randomUUID } from 'node:crypto';
import { verifyNativeSandbox } from './preflight.js';
import type { StopReceipt } from '../../../contracts/execution.js';
import { createContainerArguments, inspectOwned, workerRequest, type DockerCommand } from './docker.js';
import type { VerifiedNativeLaunch } from '../receipt/index.js';
import type { NativeStopEvidence } from '../worker/index.js';

export async function startOwnedContainer(run: DockerCommand, launch: VerifiedNativeLaunch, trialId: string, timeoutMs: number,
  signal?: AbortSignal, startupMs = 60_000) {
  const owner = randomUUID();
  const name = `paideia-${owner}`;
  let created = false;
  let stopping: Promise<StopReceipt> | undefined;
  const stop = (reason: string): Promise<StopReceipt> => {
    stopping ??= (async () => {
      let native: NativeStopEvidence | undefined;
      try {
        if (!created) return receipt('acknowledged', 'confirmed', reason, 'No native container was created');
        let state = await inspectOwned(run, name, owner);
        if (!state) return receipt('acknowledged', 'confirmed', reason, 'Owned native container is absent');
        if (state.State.Running) {
          try { native = await workerRequest<NativeStopEvidence>(run, name, '/trial/stop', {}, 6000, undefined, launch.host.port); } catch { /* outer containment remains authoritative */ }
          await run(['stop', '--time', '2', name], { timeoutMs: 5000 }).catch(() => undefined);
          state = await inspectOwned(run, name, owner);
          if (state?.State.Running) {
            await run(['kill', name], { timeoutMs: 5000 });
            const deadline = Date.now() + 3000;
            do {
              state = await inspectOwned(run, name, owner);
              if (!state?.State.Running) break;
              await new Promise(resolve => setTimeout(resolve, 100));
            } while (Date.now() < deadline);
          }
        }
        if (state?.State.Running) throw new Error('Owned container still reports running after termination');
        const removed = await run(['rm', name], { timeoutMs: 5000 });
        if (removed.code !== 0 && await inspectOwned(run, name, owner)) throw new Error('Owned stopped container could not be removed');
        if (await inspectOwned(run, name, owner)) throw new Error('Owned container remained after removal');
        return receipt('acknowledged', 'confirmed', reason, `Owned container stopped and removed; native stop ${native?.state ?? 'unavailable'}`);
      } catch (error) { return receipt('unknown', 'unknown', reason, `Container shutdown unconfirmed: ${String(error)}`); }
    })();
    return stopping;
  };
  try {
    const context = await run(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { signal });
    if (context.code !== 0 || !String(JSON.parse(context.stdout)).startsWith('unix://') ||
        process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) throw new Error('Native trials require a local Docker socket context');
    created = true;
    const create = await run(createContainerArguments(launch, name, owner, trialId, timeoutMs), { signal, timeoutMs: 30_000 });
    if (create.code !== 0 || !/^[a-f0-9]{64}$/u.test(create.stdout.trim())) throw new Error(`Native container creation failed: ${create.stderr.slice(-1000)}`);
    await inspectOwned(run, name, owner);
    const started = await run(['start', name], { signal });
    if (started.code !== 0) throw new Error(`Native container start failed: ${started.stderr.slice(-1000)}`);
    const deadline = Date.now() + startupMs;
    let lastError = '';
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Native startup aborted');
      const state = await inspectOwned(run, name, owner);
      if (!state?.State.Running) {
        const logs = await run(['logs', '--tail', '20', name]);
        throw new Error(`Native container exited before readiness: ${logs.stderr.slice(-2000)}${logs.stdout.slice(-2000)}`);
      }
      let healthy = false;
      try {
        const health = await workerRequest<{ version: string; state: string; agents: { agentId: string }[] }>(run, name, '/trial/health', undefined, 1000, signal, launch.host.port);
        const logs = await run(['logs', '--tail', '100', name], { signal });
        const ready = logs.stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } })
          .find(row => row.schema === 'paideia.daimon-native.ready.v1' && row.trialId === trialId && row.configSha256 === launch.configSha256);
        healthy = !!ready && health.version === 'noopolis.daimon.organization-runtime-health.v1' && health.state === 'running' &&
            health.agents.length === 1 && health.agents[0]?.agentId === launch.agent.id;
      } catch (error) { lastError = String(error); }
      if (healthy) { await verifyNativeSandbox(run, name, launch, trialId, signal); return { name, owner, stop }; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Native startup deadline exceeded: ${lastError}`);
  } catch (error) {
    const outcome = await stop('Native startup failed');
    if (outcome.quiescence !== 'confirmed') throw new Error(`${String(error)}; ${outcome.detail}`, { cause: error });
    throw error;
  }
}

function receipt(state: StopReceipt['state'], quiescence: StopReceipt['quiescence'], reason: string, detail: string): StopReceipt {
  return { state, scope: 'native-handle', quiescence, remoteWork: 'unknown', reason, detail };
}
