import { spawn } from "node:child_process";
import path from "node:path";

/**
 * A caller-declared step that must succeed on the new container before the
 * release counts as done (for example installing a credential the image
 * cannot carry). Executed without a shell; it must be idempotent, because a
 * failure leaves the release unrecorded and the next run deploys and runs it
 * again.
 */
export interface PostDeployHook {
  args: string[];
  command: string;
  timeoutMs: number;
}

export interface PostDeployContext {
  containerName: string;
  deployment: string;
  identity: string;
  imageId: string;
  imageTag: string;
}

export interface PostDeployResult {
  /** Null when the process ended by signal (including the timeout). */
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT_CHARS = 4_000;

export const resolvePostDeployHook = (options: {
  postDeployArg?: string[];
  postDeployCommand?: string;
  timeoutMs: number;
}): PostDeployHook | null => {
  if (options.postDeployCommand === undefined) {
    if (options.postDeployArg?.length) throw new Error("--post-deploy-arg needs --post-deploy-command");
    return null;
  }
  if (!path.isAbsolute(options.postDeployCommand)) throw new Error("--post-deploy-command must be an absolute path to an executable");
  return { args: options.postDeployArg ?? [], command: options.postDeployCommand, timeoutMs: options.timeoutMs };
};

export const postDeployEnvironment = (context: PostDeployContext, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...env,
  SPAWNFILE_RELEASE_CONTAINER: context.containerName,
  SPAWNFILE_RELEASE_DEPLOYMENT: context.deployment,
  SPAWNFILE_RELEASE_IDENTITY: context.identity,
  SPAWNFILE_RELEASE_IMAGE: context.imageTag,
  SPAWNFILE_RELEASE_IMAGE_ID: context.imageId
});

/** Keeps the tail: the end of a failing script's output is where it says why. */
const appendBounded = (current: string, chunk: string): string => {
  const next = current + chunk;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
};

export const runPostDeployCommand = (
  hook: PostDeployHook,
  context: PostDeployContext,
  signal?: AbortSignal
): Promise<PostDeployResult> =>
  new Promise((resolve, reject) => {
    let output = "";
    let timedOut = false;
    const child = spawn(hook.command, hook.args, { env: postDeployEnvironment(context), stdio: ["ignore", "pipe", "pipe"] });
    const kill = (): void => { child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, hook.timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const collect = (chunk: Buffer): void => { output = appendBounded(output, chunk.toString("utf8")); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({ exitCode: code, output, timedOut });
    });
  });
