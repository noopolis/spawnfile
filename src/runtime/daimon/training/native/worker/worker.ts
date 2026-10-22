import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createWorkerController } from './control.js';
import { MAX_TRIAL_WAKES, engineWakeTimeoutMs } from './deliveries.js';
import { assertFreshNativeEvidence } from './evidence/index.js';
import { assertNativeProfile, verifyNativeWorkerStartup, verifyWorkerPaths } from './profile.js';
import { configureNativeTaskClock, isGrokLaunch, nativeTrialArtifactsRoot, readPrivateFile } from '../receipt/index.js';
import { loadDaimonRuntime } from './public.js';
import { createWorkerServer, listenWorker } from './server.js';
import { persistNativeSandboxProjection } from './sandbox.js';

export async function runDaimonNativeWorker(args: readonly string[]): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Canonical attention acceptance requires a Linux container');
  // The same validation preparation can run through the public `verifyNativeWorkerStartup`.
  const { options, launch } = await verifyNativeWorkerStartup(args);
  const bytes = await readPrivateFile(options.config);
  const runtime = await loadDaimonRuntime(launch.agent.engine, launch.delivery);
  const grok = isGrokLaunch(launch) ? launch : undefined;
  const { createOrganizationRuntimeControlHost, parseOrganizationRuntimeConfig } = runtime;
  // Re-checked against Daimon's own parsed config, which may normalize what the raw bytes declared.
  const config = parseOrganizationRuntimeConfig(JSON.parse(bytes));
  assertNativeProfile(config, launch);
  await verifyWorkerPaths(config, options, launch);
  // Codex: the control root itself. Grok: this trial's own directory inside the container's fixed slot control root,
  // which also holds Daimon's store and the previous trials' artifacts and can therefore never be empty.
  const artifacts = nativeTrialArtifactsRoot(launch, options.trialId);
  if ((await readdir(artifacts)).length) throw new Error('Native control root must be empty before startup');
  const token = (await readPrivateFile(options.tokenFile, 4096)).trim();
  if (token.length < 24 || /\s/u.test(token)) throw new Error('Invalid isolated control token');
  // Codex meters in this process; the Grok broker is the single sealed writer of its per-slot ledger.
  const usageFile = grok ? grok.broker.usageLedgerPath : join(artifacts, 'usage.jsonl');
  const requestsFile = grok ? join(dirname(usageFile), 'requests.jsonl') : join(artifacts, 'requests.jsonl');
  await assertFreshNativeEvidence(config.agents[0]!.runtimeHomePath, usageFile, config.agents[0]!.id, launch.agent.model,
    grok ? { engine: 'grok', requestsFile } : { engine: 'codex' });
  process.env[config.host.controlTokenEnv] = token;
  process.env.NOOPOLIS_RUN_ID = options.trialId;
  process.env.DAIMON_RUNTIME_ACCEPTANCE_STORE = artifacts;
  process.env.DAIMON_TURN_USAGE_LEDGER_PATH = usageFile;
  process.env.DAIMON_TURN_REQUESTS_LEDGER_PATH = requestsFile;
  process.env.DAIMON_WAKE_FUSE_DIRECTORY = artifacts;
  process.env.DAIMON_WAKE_FUSE_EPOCH = options.trialId;
  // This owned worker has one verified launch; never inherit another slot's routing.
  if (grok) process.env.DAIMON_ENGINE_BROKER_SLOT = String(grok.broker.slot);
  else delete process.env.DAIMON_ENGINE_BROKER_SLOT;
  // Derived, never a second number: a trial must be able to execute every
  // continuation its own delivery gate will admit. One hard-coded wake here
  // accepted a continuation the runtime then refused to run at all.
  process.env.DAIMON_WAKE_FUSE_MAX_WAKES = String(MAX_TRIAL_WAKES);
  process.env.DAIMON_WAKE_FUSE_MAX_TOKENS = String(launch.limits.maxTokens);
  delete process.env.DAIMON_WAKE_FUSE;
  // Engine-neutral names; the Codex aliases stay equal so older Codex runtimes keep their bound and Daimon never sees a conflict.
  // Broker turn overrides may only lower the registered limits; the trial deadline still spans all wakes.
  process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS = String(engineWakeTimeoutMs(options.timeoutMs, launch));
  process.env.DAIMON_ENGINE_WAKE_TOKEN_CEILING = String(grok ? Math.min(launch.limits.wakeTokenCeiling, grok.broker.limits.maxTokens) : launch.limits.wakeTokenCeiling);
  process.env.DAIMON_CODEX_WAKE_TIMEOUT_MS = process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS;
  process.env.DAIMON_CODEX_WAKE_TOKEN_CEILING = process.env.DAIMON_ENGINE_WAKE_TOKEN_CEILING;
  // Set only after this worker is running. Daimon consumes the loader path for
  // child gates and strips it from engines; this process is never preloaded.
  const taskClock = configureNativeTaskClock(launch.taskClock, options.timeoutMs);
  const host = createOrganizationRuntimeControlHost(config, { acceptanceStorePath: artifacts, controlToken: token });
  const controller = createWorkerController(host, config, options, token, launch, taskClock);
  const server = createWorkerServer(controller, token);
  try {
    await host.start();
    const health = await host.health();
    const activity = await host.activityV2(token);
    if (health.state !== 'running' || !activity || !Array.isArray(activity.executions) || activity.executions.length || activity.items.length) {
      throw new Error('Native host did not start as a fresh idle runtime');
    }
    await persistNativeSandboxProjection(runtime, config, options, launch);
    await listenWorker(server, config.host.bindHost, config.host.port);
    process.stdout.write(`${JSON.stringify({ schema: 'paideia.daimon-native.ready.v1', trialId: options.trialId,
      agentId: config.agents[0]!.id, model: config.agents[0]!.engine.model,
      ...(grok ? { engine: 'grok', reasoningEffort: config.agents[0]!.engine.reasoningEffort } : {}), configSha256: options.configSha256,
      ...(taskClock ? { taskClock } : {}), ...(launch.delivery === 'transport' ? { delivery: 'transport' } : {}),
      port: config.host.port, nativeHealth: health, nativeActivity: activity })}\n`);
  } catch (error) { await controller.stop(); server.closeAllConnections(); server.close(); throw error; }
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void controller.stop().then(receipt => {
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
      server.closeAllConnections(); server.close();
      if (receipt.state !== 'acknowledged') process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
