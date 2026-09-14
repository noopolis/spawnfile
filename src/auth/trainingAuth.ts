import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

export type TrainingAuthProvider = "codex" | "grok" | "claude";
export interface TrainingAuthStageOptions {
  /** Caller-provisioned, existing private runtime home; never a host home mount. */
  home: string;
  provider: TrainingAuthProvider;
  /** Explicit provisioned leaf; default is the fixed training ingress. */
  source?: string;
}
const targets: Record<TrainingAuthProvider, readonly [string, string]> = {
  codex: [".daimon-inbound", "codex-auth"],
  grok: [".grok", "auth.json"],
  claude: [".claude", ".credentials.json"]
};
/** Stages opaque credential bytes once. Never imports configuration, logs bytes, or overwrites renewed auth. */
export const stageTrainingAuth = async (options: TrainingAuthStageOptions): Promise<{ version: "spawnfile.training-auth-stage.v1"; provider: TrainingAuthProvider; destination: string }> => {
  if (!Object.hasOwn(targets, options.provider)) throw Error("Unsupported training auth provider");
  const home = path.resolve(options.home), source = options.source ?? `/run/paideia-auth/${options.provider}`;
  if (!path.isAbsolute(options.home) || await realpath(home) !== home || !(await lstat(home)).isDirectory()) throw Error("Training home must be a canonical existing directory");
  if (!path.isAbsolute(source) || await realpath(source) !== path.resolve(source)) throw Error("Training auth source must be a canonical regular leaf");
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 1_048_576n) throw Error("Training auth source must be a bounded nonempty regular leaf");
    const [folder, leaf] = targets[options.provider];
    const directory = path.join(home, folder);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const existing = await lstat(directory);
    if (!existing.isDirectory() || existing.isSymbolicLink() || existing.mode % 512 !== 0o700 || await realpath(directory) !== directory) throw Error("Training auth directory must be private and canonical");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let primary: unknown;
    const destination = path.join(directory, leaf), temporary = path.join(directory, `.stage-${randomUUID()}`);
    try {
      let length = 0;
      while (length < bytes.length) {
        const read = await input.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const after = await input.stat({ bigint: true });
      if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.ino !== before.ino || after.dev !== before.dev || after.birthtimeNs !== before.birthtimeNs) throw Error("Training auth source changed during staging");
      const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await output.writeFile(bytes.subarray(0, length)); await output.sync(); }
      finally { await output.close(); }
      // Exclusive publication preserves renewed credentials and never exposes a partial leaf.
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("Training auth already present; renewed credential preserved");
        throw error;
      }
    } catch (error) { primary = error; throw error; } finally {
      bytes.fill(0);
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return;
        if (primary) throw new AggregateError([primary, error], "Training auth staging failed and temporary cleanup is incomplete");
        throw error;
      });
    }
    return { version: "spawnfile.training-auth-stage.v1", provider: options.provider, destination };
  } finally { await input.close(); }
};
