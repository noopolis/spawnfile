import { randomUUID } from "node:crypto";

import type { NativeTrainingDriver, NativeTrainingInstance } from "../nativeTraining.js";
import { opencodeBinary, opencodeEnvironment } from "./launch.js";
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

// The native export consists of these two session reads. Read them from the same
// service that ran the turn so training never opens a second provider or account.
const readTranscript = `const [origin, directory, title, knownSession] = process.argv.slice(1);
async function read(path, query = {}) {
  const url = new URL(path, origin);
  url.searchParams.set("directory", directory);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers = password ? {authorization: "Basic " + Buffer.from((process.env.OPENCODE_SERVER_USERNAME ?? "opencode") + ":" + password).toString("base64")} : {};
  const response = await fetch(url, {redirect: "error", headers});
  if (!response.ok) throw new Error("OpenCode transcript unavailable");
  return response.json();
}
let session = knownSession;
if (!session) {
  const matches = (await read("/session", {search: title})).filter(info => info.title === title && info.directory === directory && !info.parentID);
  if (matches.length !== 1) throw new Error("Ambiguous OpenCode training session");
  session = matches[0].id;
}
if (!/^ses_[a-zA-Z0-9]+$/.test(session)) throw new Error("Invalid OpenCode session");
const base = "/session/" + session;
const [info, messages] = await Promise.all([read(base), read(base + "/message")]);
process.stdout.write(JSON.stringify({info, messages}));`;

export const opencodeTrainingDriver: NativeTrainingDriver = {
  serviceEnvironment: { OPENCODE_DISABLE_AUTOCOMPACT: "true", OPENCODE_DISABLE_PRUNE: "true" },
  async run(instance, turn) {
    if (!turn.sessionId || !turn.trialId || !turn.wakeId || !turn.text.trim() || turn.text.includes("\0")) {
      throw new Error("Invalid OpenCode training turn");
    }
    turn.signal?.throwIfAborted();
    const { port } = instance;
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("OpenCode training requires its compiled service port");
    }
    const origin = `http://127.0.0.1:${port}`;
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
    const env = opencodeEnvironment(instance.configPath, instance.homePath, instance.workspacePath);
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
      const stdout = await exec([
        "/bin/bash", "-c", 'prompt=$1; shift; exec "$@" < <(printf "%s" "$prompt")', "opencode-run", turn.text,
        opencodeBinary, "run", "--attach", origin, "--dir", instance.workspacePath, "--format", "json", ...args
      ]);
      const { session, events } = readOpenCodeEvents(stdout, trial.nativeId);
      const transcript = await exec(["node", "--input-type=module", "-e", readTranscript, origin, instance.workspacePath, title, session ?? ""]);
      const reply = bindOpenCodeReply(events, transcript, {
        session, title, workspace: instance.workspacePath, previousUsers: trial.users, prompt: turn.text
      }, turn, trial.sequence);
      trial.nativeId = reply.session;
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
