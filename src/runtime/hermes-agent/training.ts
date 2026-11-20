import { hermesSurfaceEnvCommand } from "./surfaces.js";
import { posix } from "node:path";
import type { NativeTrainingDriver, NativeTrainingInstance, NativeTrainingTurn } from "../nativeTraining.js";
import { hermesAuthLaunchCommand } from "./authLaunch.js";
import { hermesNativeSessionCommand } from "./sessionStore.js";
import { hermesConfigFile } from "./config.js";
import { hermesEnvCommand, hermesEnvironment } from "./instance.js";
import { emptyHermesTotals, hermesTurnUsage, readHermesTurn, type HermesTokenTotals } from "./trainingEvents.js";

interface TrialSession {
  trialId: string;
  sessionId: string;
  nativeId?: string;
  endedAt?: number;
  busy: boolean;
  failed: boolean;
  wakes: Set<string>;
  sequence: number;
  totals: HermesTokenTotals | null;
}

const sessions = new WeakMap<NativeTrainingInstance, TrialSession>();

// A chat client can auto-start an idle-exit gateway before the foreground owner
// finishes booting. Probe without auto-start and discard the attach ticket.
const chatOnReadyGateway = [
  ...hermesEnvCommand, ...hermesSurfaceEnvCommand, ...hermesAuthLaunchCommand, ...hermesNativeSessionCommand, "bash", "-c",
  'for ((attempt=0; attempt<60; attempt++)); do if hermes gateway attach --json >/dev/null 2>&1; then exec hermes chat "$@"; fi; sleep 1; done; exit 1',
  "hermes-training"
];

function getTrial(instance: NativeTrainingInstance, turn: NativeTrainingTurn): TrialSession {
  const state = sessions.get(instance);
  if (state) return state;
  const fresh = {
    trialId: turn.trialId, sessionId: turn.sessionId, busy: false, failed: false, wakes: new Set<string>(), sequence: 0,
    totals: emptyHermesTotals
  };
  sessions.set(instance, fresh);
  return fresh;
}

export const hermesTrainingDriver: NativeTrainingDriver = {
  async run(instance, turn) {
    if (!turn.text.trim()) throw new Error("Hermes Agent training requires a nonempty prompt");
    if (instance.configPath !== posix.join(instance.homePath, hermesConfigFile)) {
      throw new Error("Hermes Agent training config is outside its native home");
    }
    const state = getTrial(instance, turn);
    if (state.trialId !== turn.trialId || state.sessionId !== turn.sessionId) {
      throw new Error("Hermes Agent training instance belongs to another trial");
    }
    if (state.busy || state.failed || state.wakes.has(turn.wakeId)) {
      throw new Error("Hermes Agent training turn cannot be started or repeated");
    }
    turn.signal?.throwIfAborted();
    state.wakes.add(turn.wakeId);
    state.busy = true;
    try {
      const continuation = state.nativeId ? ["--resume", state.nativeId] : ["--in", instance.workspacePath];
      const stdout = await instance.exec(
        [...chatOnReadyGateway, `-q=${turn.text}`, "--format", "stream-json", ...continuation],
        { env: hermesEnvironment(instance.homePath, instance.workspacePath), signal: turn.signal, timeoutMs: turn.timeoutMs }
      );
      turn.signal?.throwIfAborted();
      const { session, endedAt, observations, totals, ...reply } = readHermesTurn(stdout, state.nativeId, state.endedAt, turn);
      const usage = hermesTurnUsage(state.totals, totals);
      state.nativeId = session;
      state.endedAt = endedAt;
      state.totals = totals;
      return {
        ...reply,
        usage,
        observations: observations.map(event => ({ ...event, seq: ++state.sequence }))
      };
    } catch (error) {
      // A lost receipt can leave work at the gateway. The common trial owner tears down the container.
      state.failed = true;
      throw error;
    } finally {
      state.busy = false;
    }
  }
};
