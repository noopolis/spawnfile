import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import type { NativeTrainingDriver, NativeTrainingInstance } from "../nativeTraining.js";
import { opencodeEnvironment, opencodeLaunchCommand } from "./launch.js";
import { bindOpenCodeReply, readOpenCodeEvents } from "./trainingEvidence.js";

interface TrialSession {
  sessionId: string;
  trialId: string;
  token: string;
  nativeId?: string;
  users: string[];
  sequence: number;
  wakes: Set<string>;
  busy: boolean;
  failed: boolean;
}

const sessions = new WeakMap<NativeTrainingInstance, TrialSession>();

export const opencodeTrainingDriver: NativeTrainingDriver = {
  async run(instance, turn) {
    if (!turn.sessionId || !turn.trialId || !turn.wakeId || !turn.text.trim() || turn.text.includes("\0")) {
      throw new Error("Invalid OpenCode training turn");
    }
    turn.signal?.throwIfAborted();
    const trial: TrialSession = sessions.get(instance) ?? {
      sessionId: turn.sessionId, trialId: turn.trialId, token: randomUUID(),
      users: [], sequence: 0, wakes: new Set(), busy: false, failed: false
    };
    if (trial.sessionId !== turn.sessionId || trial.trialId !== turn.trialId ||
        trial.busy || trial.failed || trial.wakes.has(turn.wakeId)) {
      throw new Error("OpenCode training session cannot accept this turn");
    }
    sessions.set(instance, trial);
    trial.busy = true;
    trial.wakes.add(turn.wakeId);

    const title = `spawnfile-training-${trial.token}`;
    const env = {
      ...opencodeEnvironment(instance.configPath, instance.homePath, instance.workspacePath),
      XDG_DATA_HOME: posix.join(instance.homePath, ".local/share/training", trial.token),
      OPENCODE_DISABLE_AUTOCOMPACT: "true",
      OPENCODE_DISABLE_PRUNE: "true"
    };
    const deadline = performance.now() + turn.timeoutMs;
    const exec = async (argv: string[]) => {
      turn.signal?.throwIfAborted();
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (!(timeoutMs > 0)) throw new Error("OpenCode training turn timed out");
      const stdout = await instance.exec(argv, { env, signal: turn.signal, timeoutMs }).catch(() => {
        turn.signal?.throwIfAborted();
        throw new Error("OpenCode native command failed");
      });
      turn.signal?.throwIfAborted();
      return stdout;
    };

    try {
      // The pinned CLI quotes positional arguments containing spaces. Feed
      // stdin through a fixed script to preserve the exact turn bytes.
      const args = trial.nativeId ? ["--session", trial.nativeId] : ["--title", title];
      const command = opencodeLaunchCommand(instance.homePath);
      const stdout = await exec([
        "/bin/bash", "-c", 'prompt=$1; shift; exec "$@" < <(printf "%s" "$prompt")', "opencode-run", turn.text,
        ...command, "run", "--dir", instance.workspacePath, "--format", "json", ...args
      ]);
      const { session, events } = readOpenCodeEvents(stdout, trial.nativeId);
      const transcript = await exec([...command, "export", session]);
      const reply = bindOpenCodeReply(events, transcript, {
        session, title, workspace: instance.workspacePath, previousUsers: trial.users, prompt: turn.text
      }, turn, trial.sequence);
      trial.nativeId = session;
      trial.users = reply.users;
      trial.sequence += reply.observations.length;
      return {
        text: reply.text,
        observations: reply.observations,
        usage: reply.usage,
        toolCoverage: { channel: "tools", completeness: "partial", ordering: reply.observations.length ? "source" : "none" }
      };
    } catch (error) {
      trial.failed = true;
      throw error;
    } finally {
      trial.busy = false;
    }
  }
};
