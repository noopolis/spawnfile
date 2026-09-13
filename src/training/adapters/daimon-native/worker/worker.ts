import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkerController } from './control.js';
import { assertFreshNativeEvidence } from './evidence.js';
import { assertNativeProfile, parseWorkerArguments, verifyWorkerPaths } from './profile.js';
import { parseNativeLaunch, readPrivateFile, sha256 } from '../receipt/index.js';
import { loadDaimonRuntime } from './public.js';
import { createWorkerServer, listenWorker } from './server.js';
import { persistNativeSandboxProjection } from './sandbox.js';

export async function runDaimonNativeWorker(args: readonly string[]): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Canonical attention acceptance requires a Linux container');
  const options = parseWorkerArguments(args);
  const launch = parseNativeLaunch(JSON.parse(await readPrivateFile(options.launch, 65536)));
  const bytes = await readPrivateFile(options.config);
  if (sha256(bytes) !== options.configSha256 || launch.configSha256 !== options.configSha256) throw new Error('Compiled native config digest mismatch');
  const runtime = await loadDaimonRuntime();
  const { createOrganizationRuntimeControlHost, parseOrganizationRuntimeConfig } = runtime;
  const config = parseOrganizationRuntimeConfig(JSON.parse(bytes));
  assertNativeProfile(config, launch);
  await verifyWorkerPaths(config, options, launch);
  if ((await readdir(options.controlRoot)).length) throw new Error('Native control root must be empty before startup');
  const token = (await readPrivateFile(options.tokenFile, 4096)).trim();
  if (token.length < 24 || /\s/u.test(token)) throw new Error('Invalid isolated control token');
  const usageFile = join(options.controlRoot, 'usage.jsonl');
  await assertFreshNativeEvidence(config.agents[0]!.runtimeHomePath, usageFile, config.agents[0]!.id, launch.agent.model);
  process.env[config.host.controlTokenEnv] = token;
  process.env.NOOPOLIS_RUN_ID = options.trialId;
  process.env.DAIMON_RUNTIME_ACCEPTANCE_STORE = options.controlRoot;
  process.env.DAIMON_TURN_USAGE_LEDGER_PATH = usageFile;
  process.env.DAIMON_TURN_REQUESTS_LEDGER_PATH = join(options.controlRoot, 'requests.jsonl');
  process.env.DAIMON_WAKE_FUSE_DIRECTORY = options.controlRoot;
  process.env.DAIMON_WAKE_FUSE_EPOCH = options.trialId;
  process.env.DAIMON_WAKE_FUSE_MAX_WAKES = '1';
  process.env.DAIMON_WAKE_FUSE_MAX_TOKENS = String(launch.limits.maxTokens);
  delete process.env.DAIMON_WAKE_FUSE;
  process.env.DAIMON_CODEX_WAKE_TIMEOUT_MS = String(options.timeoutMs);
  process.env.DAIMON_CODEX_WAKE_TOKEN_CEILING = String(launch.limits.wakeTokenCeiling);
  const host = createOrganizationRuntimeControlHost(config, { acceptanceStorePath: options.controlRoot, controlToken: token });
  const controller = createWorkerController(host, config, options, token, launch);
  const server = createWorkerServer(controller, token);
  try {
    await host.start();
    const health = await host.health();
    const activity = await host.activityV2(token);
    if (health.state !== 'running' || !activity || !Array.isArray(activity.executions) || activity.executions.length || activity.items.length) {
      throw new Error('Native host did not start as a fresh idle runtime');
    }
    await persistNativeSandboxProjection(runtime, config, options);
    await listenWorker(server, config.host.bindHost, config.host.port);
    process.stdout.write(`${JSON.stringify({ schema: 'paideia.daimon-native.ready.v1', trialId: options.trialId,
      agentId: config.agents[0]!.id, model: config.agents[0]!.engine.model, configSha256: options.configSha256,
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
