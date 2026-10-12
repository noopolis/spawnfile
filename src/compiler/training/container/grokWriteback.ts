import path from "node:path";
import { writeBackTrainingGrokCredential } from "../../../auth/index.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";

type DockerCall = (args: string[], cleanup: boolean) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Called only for an ownership-verified container, before removal, including failure/cancellation. */
export const persistTrainingGrokCredential = async (id: string, profile: string, scratch: string, call: DockerCall): Promise<void> => {
  const state = await call(["inspect", "--format", "{{json .State}}", id], true);
  if (state.code !== 0) throw Error("Cannot verify training credential writer state");
  if (JSON.parse(state.stdout).Running === true) {
    const stopped = await call(["stop", "--time", "5", id], true);
    if (stopped.code !== 0) throw Error("Cannot stop training credential writer");
  }
  const terminal = await call(["inspect", "--format", "{{json .State}}", id], true);
  if (terminal.code !== 0 || JSON.parse(terminal.stdout).Running !== false) throw Error("Training credential writer is still active");
  const realm = DAIMON_GROK_ENGINE_BROKER.credentialHomePath;
  const candidate = path.join(scratch, "grok-auth.json"), journal = path.join(scratch, "grok-journal.json");
  // Docker writes directly into a host-private directory: no credential bytes in stdout, logs or arguments.
  const copied = await call(["cp", `${id}:${realm}/auth.json`, candidate], true);
  if (copied.code !== 0) throw Error("Cannot export training Grok credential");
  const journalCopy = await call(["cp", `${id}:${realm}/.daimon-broker/credential-journal.json`, journal], true);
  // A realm that never rotated has no journal. The auth owner accepts only unchanged bytes in that case.
  await writeBackTrainingGrokCredential(profile, candidate, journalCopy.code === 0 ? journal : `${journal}.absent`);
};
