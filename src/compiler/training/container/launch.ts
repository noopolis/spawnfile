import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS } from "../../../shared/index.js";
import { assertNotDesktopGrokAuth } from "../broker/entrypoint.js";
import { TRAINING_BROKER_ENTRYPOINT, trainingBrokerMounts, trainingBrokerSecurityArgs, trainingBrokerTmpfsTargets } from "./security.js";
import { parseDetachedContainerInspect } from "../../runProjectDocker.js";
import type { TrainingContext } from "../contract.js";
import { trainingImageSchema } from "./contract.js";
import { prepareTrainingContainer } from "./prepare.js";
import { runTrainingDocker, type TrainingDockerProcess } from "./process.js";
import { repairEnvelopeSchema } from "../repair/contract.js";
import { hashJson } from "../preparation/files.js";
import { parseTrainingMappedPreparation } from "../preparation/contract.js";

export interface LaunchTrainingContainerOptions {
  image: string; configPath: string; context: TrainingContext; args: readonly string[];
  timeoutMs: number; signal?: AbortSignal;
  streams: { stdout(line: string): void; stderr(line: string): void };
  process?: TrainingDockerProcess;
  preparationPath?: string;
  repairPath?: string;
}
const inspectFormat = "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}";
export const launchTrainingContainer = async (options: LaunchTrainingContainerOptions): Promise<number> => {
  if (options.signal?.aborted) return 130;
  const image = trainingImageSchema.parse(options.image);
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) throw Error("Training requires an explicit non-root local user");
  const configBytes = await readFile(options.configPath, "utf8");
  if (Buffer.byteLength(configBytes) > 1024 * 1024) throw Error("Training launch config exceeds 1 MiB");
  const prepared = await prepareTrainingContainer(JSON.parse(configBytes), options.context, options.args);
  // D2: the training Grok login is a dedicated one. Refuse the developer's desktop leaf before Docker ever sees it.
  if (prepared.config.broker) assertNotDesktopGrokAuth(prepared.config.broker.bootstrap);
  if (options.preparationPath) {
    if (await realpath(options.preparationPath) !== options.preparationPath) throw Error("Preparation receipt path must be canonical");
    parseTrainingMappedPreparation(JSON.parse(await readFile(options.preparationPath, "utf8")));
  }
  if (options.repairPath) {
    if (await realpath(options.repairPath) !== options.repairPath) throw Error("Repair receipt path must be canonical");
    const raw = JSON.parse(await readFile(options.repairPath, "utf8"));
    const envelope = repairEnvelopeSchema.parse(raw);
    if (hashJson(raw.receipt) !== envelope.digest || envelope.receipt.current.imageId !== image ||
      !prepared.config.inputs.some(input => input.destination === envelope.receipt.parent.root)) throw Error("Repair receipt launch identity mismatch");
  }
  const execute = options.process ?? runTrainingDocker;
  const controller = new AbortController(), deadline = Date.now() + options.timeoutMs;
  let interrupted = false, timedOut = false;
  const interrupt = (): void => { interrupted = true; controller.abort(); };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", interrupt, { once: true });
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  if (options.signal?.aborted) interrupt();
  const prefix = ["--context", prepared.config.dockerContext];
  const call = async (args: string[], cleanup = false, stream = false) => {
    if (!cleanup && controller.signal.aborted) throw Error("Container operation cancelled");
    return execute([...prefix, ...args], {
    timeoutMs: cleanup ? 10_000 : Math.max(1, deadline - Date.now()),
    ...(cleanup ? {} : { signal: controller.signal }), ...(stream ? options.streams : {})
  }); };
  const name = `spawnfile-training-${randomUUID()}`;
  const labels = { "com.spawnfile.training.owner": name };
  let privateRoot: string | undefined, containerId: string | undefined, creationAttempted = false;
  let expectedImage: string | undefined, lastLine = "", closureVerified = false;
  try {
    const endpoint = await execute(["context", "inspect", prepared.config.dockerContext, "--format", "{{json .Endpoints.docker.Host}}"], { timeoutMs: 10_000, signal: controller.signal });
    if (endpoint.code !== 0 || !/^unix:\/\//u.test(JSON.parse(endpoint.stdout))) throw Error("Training requires an explicitly selected local Unix Docker context");
    const inspected = await call(["image", "inspect", image, "--format", "{{.Id}}"]);
    expectedImage = inspected.stdout.trim();
    if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(expectedImage) || (image.startsWith("sha256:") && image !== expectedImage)) throw Error("Training image must be locally available with an immutable identity");
    privateRoot = await realpath(await mkdtemp(path.join(path.dirname(prepared.config.output.source), ".spawnfile-training-container-")));
    await chmod(privateRoot, 0o700);
    const contextFile = path.join(privateRoot, "context.json");
    await writeFile(contextFile, JSON.stringify(prepared.context), { mode: 0o444, flag: "wx" });
    const mounts = [...prepared.config.inputs.map((entry) => `type=bind,src=${entry.source},dst=${entry.destination},readonly`),
      `type=bind,src=${prepared.config.output.source},dst=/run/training/output`,
      `type=bind,src=${contextFile},dst=/run/paideia/context.json,readonly`,
      ...options.preparationPath ? [`type=bind,src=${options.preparationPath},dst=/run/paideia/preparation.json,readonly`] : [],
      ...options.repairPath ? [`type=bind,src=${options.repairPath},dst=/run/paideia/repair.json,readonly`] : [],
      ...prepared.config.auth.map((entry) => `type=bind,src=${entry.source},dst=/run/paideia-auth/${entry.provider},readonly`)];
    const broker = prepared.config.broker;
    // A brokered Grok slot runs the launcher, the broker and the model's own worker uid inside this container, so it
    // starts as root with the production Daimon capability set instead of the host user with no capabilities at all.
    const privilege = broker
      ? [...await trainingBrokerSecurityArgs(privateRoot), "--pids-limit", "2048",
        ...trainingBrokerTmpfsTargets().flatMap((entry) => ["--tmpfs", `${entry.path}:rw,nosuid,nodev,size=${entry.size},mode=${entry.mode}`])]
      : ["--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        ...DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS, "--pids-limit", "512",
        "--tmpfs", `/tmp:rw,nosuid,nodev,size=1g,uid=${uid},gid=${gid},mode=1777`, "--tmpfs", `/work:rw,nosuid,nodev,size=4g,uid=${uid},gid=${gid},mode=700`,
        "--tmpfs", `/home/training:rw,nosuid,nodev,size=1g,uid=${uid},gid=${gid},mode=700`];
    const args = ["create", "--name", name, "--label", `com.spawnfile.training.owner=${name}`,
      "--init", "--read-only", ...privilege,
      "--env", "HOME=/home/training", "--workdir", "/work", "--entrypoint", broker ? TRAINING_BROKER_ENTRYPOINT : "/opt/training/bin/train",
      ...[...mounts, ...(broker ? trainingBrokerMounts(broker) : [])].flatMap((mount) => ["--mount", mount]),
      ...(prepared.viewerPort === undefined ? [] : ["--publish", `127.0.0.1:${prepared.viewerPort}:${prepared.viewerPort}`]), expectedImage,
      "train", "--spawnfile-context", "/run/paideia/context.json", ...prepared.args];
    creationAttempted = true;
    const created = await call(args);
    containerId = created.stdout.trim();
    if (created.code !== 0 || !/^[a-f0-9]{64}$/u.test(containerId)) {
      let diagnostic = created.stderr;
      for (const auth of prepared.config.auth) diagnostic = diagnostic.replaceAll(auth.source, "[auth source]");
      diagnostic = diagnostic.replace(/\p{Cc}/gu, " ").trim().slice(0, 2048);
      throw Error(`Docker did not return a valid training container identity${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    const identity = await call(["inspect", "--format", inspectFormat, containerId]);
    if (identity.code !== 0 || parseDetachedContainerInspect(identity.stdout, containerId, labels, name).imageId !== expectedImage) throw Error("Training container identity mismatch");
    if (controller.signal.aborted) throw Error("Container operation cancelled");
    const result = await execute([...prefix, "start", "--attach", containerId], {
      timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal,
      stdout: (line) => { if (line.trim()) lastLine = line; options.streams.stdout(line); }, stderr: options.streams.stderr
    });
    const terminal = await call(["inspect", "--format", "{{json .State}}", containerId]);
    const state = JSON.parse(terminal.stdout) as { Running?: unknown; ExitCode?: unknown };
    if (terminal.code !== 0 || state.Running !== false || !Number.isInteger(state.ExitCode) || result.code !== state.ExitCode) throw Error("Training container final state is unverified");
    if (state.ExitCode !== 0 && state.ExitCode !== 1) return state.ExitCode as number;
    const receipt = JSON.parse(lastLine) as { status?: unknown; index?: unknown };
    if (receipt.status !== "completed" || typeof receipt.index !== "string" || !receipt.index.startsWith("/run/training/output/") || path.posix.normalize(receipt.index) !== receipt.index) throw Error("Training exited without a valid final receipt");
    const artifact = path.join(prepared.config.output.source, receipt.index.slice("/run/training/output/".length));
    if (await realpath(artifact) !== artifact || !(await stat(artifact)).isFile()) throw Error("Training completion artifact is missing or escapes output");
    return state.ExitCode as number;
  } catch (error) {
    if (interrupted) return 130;
    if (timedOut) throw Error("Container training exceeded command deadline");
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", interrupt);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    try {
      if (creationAttempted) {
        // A timed-out create may still have created our uniquely labelled container.
        const found = await call(["inspect", "--format", inspectFormat, name], true);
        if (found.code === 0) {
          const id: unknown = JSON.parse(found.stdout.split("\n")[0]!);
          if (typeof id !== "string" || parseDetachedContainerInspect(found.stdout, id, labels, name).imageId !== expectedImage || (containerId && /^[a-f0-9]{64}$/u.test(containerId) && id !== containerId)) throw Error("Refusing cleanup of unverified training container");
          const removed = await call(["rm", "--force", id], true);
          const remaining = await call(["container", "ls", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"], true);
          if (removed.code !== 0 || remaining.code !== 0 || remaining.stdout.trim()) throw Error("Training container cleanup is unverified");
          closureVerified = true;
        } else {
          const remaining = await call(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], true);
          if (remaining.code !== 0 || remaining.stdout.trim()) throw Error("Training container closure is unknown");
          closureVerified = true;
        }
      }
    } finally { if (privateRoot && (!creationAttempted || closureVerified)) await rm(privateRoot, { recursive: true, force: true }); }
  }
};
