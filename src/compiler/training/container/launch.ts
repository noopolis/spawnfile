import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS } from "../../../shared/index.js";
import { parseTrainingBrokerDeclaration } from "../broker/declaration.js";
import { trainingSlotsDocument, TRAINING_SLOTS_FILE } from "../broker/paths.js";
import { assertNotDesktopGrokAuth } from "../broker/entrypoint.js";
import { TRAINING_BROKER_ENTRYPOINT, trainingBrokerMounts, trainingBrokerSecurityArgs, trainingBrokerTmpfsTargets, trainingRunRequestMount } from "./security.js";
import { parseDetachedContainerInspect } from "../../runProjectDocker.js";
import { mapTrainingExecution, trainingExecutionSchema, TRAINING_EXECUTION_FILE, TRAINING_EXECUTION_CAPABILITY_LABEL, TRAINING_EXECUTION_VERSION, type TrainingExecution } from "../execution.js";
import { verifyCanonicalPins } from "../preparation/inputs.js";
import { removeTrainingPreparationScratch } from "../preparation/scratch.js";
import type { TrainingContext } from "../contract.js";
import { trainingImageSchema } from "./contract.js";
import { prepareTrainingEvaluators } from "./evaluators.js";
import { prepareTrainingContainer } from "./prepare.js";
import { runTrainingDocker, type TrainingDockerProcess } from "./process.js";
import { repairEnvelopeSchema } from "../repair/contract.js";
import { hashJson } from "../preparation/files.js";
import { parseTrainingMappedPreparation } from "../preparation/contract.js";
import { persistTrainingGrokCredential } from "./grokWriteback.js";
import { nativeTrainingSlotsDocument } from "./nativeSlots.js";
import { createTrainingOutputVolume, trainingOutputVolumeEnabled } from "./outputVolume.js";

// The image bakes /run/training/inputs as 0:2000 0750 for brokered worker isolation; the
// non-brokered host-uid evaluator joins that group so it can still traverse its own inputs.
export const TRAINING_INPUTS_GID = 2_000;

export interface LaunchTrainingContainerOptions {
  image: string; configPath: string; context: TrainingContext; args: readonly string[];
  timeoutMs: number; signal?: AbortSignal;
  streams: { stdout(line: string): void; stderr(line: string): void };
  process?: TrainingDockerProcess;
  execution?: TrainingExecution;
  preparationPath?: string;
  repairPath?: string;
}
const inspectFormat = "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}";
export const launchTrainingContainer = async (options: LaunchTrainingContainerOptions): Promise<number> => {
  if (options.signal?.aborted) return 130;
  const image = trainingImageSchema.parse(options.image);
  const volumeEnabled = trainingOutputVolumeEnabled();
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) throw Error("Training requires an explicit non-root local user");
  const configBytes = await readFile(options.configPath, "utf8");
  if (Buffer.byteLength(configBytes) > 1024 * 1024) throw Error("Training launch config exceeds 1 MiB");
  const raw = JSON.parse(configBytes);
  const prepared = await prepareTrainingContainer(options.execution
    ? { ...raw, output: { ...raw.output, source: options.execution.output } } : raw, options.context, options.args,
    { createOutput: options.execution !== undefined && !options.args.includes("--resume") });
  const execution = options.execution ? mapTrainingExecution(options.execution, file => {
    const absolute = path.resolve(file);
    const binding = [...prepared.config.inputs, prepared.config.output].find(entry =>
      absolute === entry.source || absolute.startsWith(entry.source + path.sep));
    if (!binding) throw Error(`Training execution path is not covered by a declared mount: ${file}`);
    return path.posix.join(binding.destination, path.relative(binding.source, absolute).split(path.sep).join("/"));
  }) : undefined;
  if (options.execution) await verifyCanonicalPins(prepared.config.inputs.map((input, index) =>
    ({ ...input, id: String(index), digest: "" })), options.execution.datasetPins, prepared.config.inputs.map(input => input.source));
  // D2: the training Grok login is a dedicated one. Refuse the developer's desktop leaf before Docker ever sees it.
  if (prepared.config.broker) {
    assertNotDesktopGrokAuth(prepared.config.broker.bootstrap);
    const declaration = parseTrainingBrokerDeclaration(JSON.parse(await readFile(prepared.config.broker.declaration, "utf8")));
    if (declaration.slots !== prepared.config.slots) throw Error("Training launch and broker declaration slots differ");
  }
  if (options.preparationPath) {
    if (await realpath(options.preparationPath) !== options.preparationPath) throw Error("Preparation receipt path must be canonical");
    parseTrainingMappedPreparation(JSON.parse(await readFile(options.preparationPath, "utf8")));
  }
  if (options.repairPath) {
    if (await realpath(options.repairPath) !== options.repairPath) throw Error("Repair receipt path must be canonical");
    const raw = JSON.parse(await readFile(options.repairPath, "utf8"));
    const envelope = repairEnvelopeSchema.parse(raw);
    if (["native", "trials", "optimizer"].some(name => name in envelope.receipt.compatibility.components)) {
      throw Error("Repair receipt references external training components; re-prepare with Spawnfile before repairing measurements");
    }
    if (hashJson(raw.receipt) !== envelope.digest || envelope.receipt.current.imageId !== image ||
      !prepared.config.inputs.some(input => input.destination === envelope.receipt.parent.root)) throw Error("Repair receipt launch identity mismatch");
  }
  const execute = options.process ?? runTrainingDocker;
  const controller = new AbortController(), deadline = Date.now() + options.timeoutMs;
  let interrupted = false, timedOut = false;
  const interrupt = (): void => { interrupted = true; controller.abort(); };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", interrupt, { once: true });
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  if (options.signal?.aborted) interrupt();
  const prefix = ["--context", prepared.config.dockerContext];
  const call = async (args: string[], cleanup = false, stream = false, cleanupTimeoutMs = 10_000) => {
    if (!cleanup && controller.signal.aborted) throw Error("Container operation cancelled");
    return execute([...prefix, ...args], {
    timeoutMs: cleanup ? cleanupTimeoutMs : Math.max(1, deadline - Date.now()),
    ...(cleanup ? {} : { signal: controller.signal }), ...(stream ? options.streams : {})
  }); };
  const name = `spawnfile-training-${randomUUID()}`;
  const labels = { "com.spawnfile.training.owner": name };
  let privateRoot: string | undefined, containerId: string | undefined, creationAttempted = false, startAttempted = false;
  let expectedImage: string | undefined, lastLine = "", closureVerified = false;
  let outputVolume: ReturnType<typeof createTrainingOutputVolume> | undefined;
  try {
    const endpoint = await execute(["context", "inspect", prepared.config.dockerContext, "--format", "{{json .Endpoints.docker.Host}}"], { timeoutMs: 10_000, signal: controller.signal });
    if (endpoint.code !== 0 || !/^unix:\/\//u.test(JSON.parse(endpoint.stdout))) throw Error("Training requires an explicitly selected local Unix Docker context");
    const inspected = await call(["image", "inspect", image, "--format", "{{.Id}}"]);
    expectedImage = inspected.stdout.trim();
    if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(expectedImage) || (image.startsWith("sha256:") && image !== expectedImage)) throw Error("Training image must be locally available with an immutable identity");
    if (execution) {
      const capability = await call(["image", "inspect", expectedImage, "--format", `{{json (index .Config.Labels "${TRAINING_EXECUTION_CAPABILITY_LABEL}")}}`]);
      if (capability.code !== 0 || capability.stdout.trim() !== JSON.stringify(TRAINING_EXECUTION_VERSION)) {
        throw Error(`Authored training requires an image implementing --spawnfile-execution ${TRAINING_EXECUTION_FILE} and labelled ${TRAINING_EXECUTION_CAPABILITY_LABEL}=${TRAINING_EXECUTION_VERSION}; legacy Training datasets are incompatible`);
      }
    }
    privateRoot = await realpath(await mkdtemp(path.join(path.dirname(prepared.config.output.source), ".spawnfile-training-container-")));
    await chmod(privateRoot, 0o700);
    const contextFile = path.join(privateRoot, "context.json");
    await writeFile(contextFile, JSON.stringify(prepared.context), { mode: 0o444, flag: "wx" });
    const executionFile = path.join(privateRoot, "execution.json");
    if (execution) await writeFile(executionFile, JSON.stringify(trainingExecutionSchema.parse(execution)), { mode: 0o444, flag: "wx" });
    const evaluators = await prepareTrainingEvaluators(privateRoot, prepared.config, prepared.args);
    if (volumeEnabled) {
      outputVolume = createTrainingOutputVolume({ name, image: expectedImage, host: prepared.config.output.source, scratch: privateRoot,
        uid, gid, runtimeUid: prepared.config.broker ? 2000 : uid, runtimeGid: prepared.config.broker ? 2000 : gid,
        context: prepared.config.dockerContext, call: (args, cleanup) => call(args, cleanup, false, 120_000), stderr: options.streams.stderr });
      await outputVolume.seed();
    }
    const mounts = [...evaluators.mounts, ...prepared.config.inputs.map((entry) => `type=bind,src=${entry.source},dst=${entry.destination},readonly`),
      outputVolume?.mount ?? `type=bind,src=${prepared.config.output.source},dst=/run/training/output`,
      `type=bind,src=${contextFile},dst=/run/spawnfile-training/context.json,readonly`,
      ...execution ? [`type=bind,src=${executionFile},dst=${TRAINING_EXECUTION_FILE},readonly`] : [],
      ...options.preparationPath ? [`type=bind,src=${options.preparationPath},dst=/run/spawnfile-training/preparation.json,readonly`] : [],
      ...options.repairPath ? [`type=bind,src=${options.repairPath},dst=/run/spawnfile-training/repair.json,readonly`] : [],
      ...prepared.config.auth.map((entry) => `type=bind,src=${entry.source},dst=/run/spawnfile-training-auth/${entry.provider},readonly`)];
    const broker = prepared.config.broker;
    if (broker) {
      mounts.push(trainingRunRequestMount(prepared.config.output.source, prepared.args));
      const slotsFile = path.join(privateRoot, "slots.json");
      await writeFile(slotsFile, `${JSON.stringify(trainingSlotsDocument(prepared.config.slots))}\n`, { mode: 0o444, flag: "wx" });
      mounts.push(`type=bind,src=${slotsFile},dst=${TRAINING_SLOTS_FILE},readonly`);
    } else {
      const slotsFile = path.join(privateRoot, "slots.json");
      await writeFile(slotsFile, `${JSON.stringify(nativeTrainingSlotsDocument(prepared.config.slots, uid))}\n`, { mode: 0o444, flag: "wx" });
      mounts.push(`type=bind,src=${slotsFile},dst=${TRAINING_SLOTS_FILE},readonly`);
    }
    // A brokered Grok slot runs the launcher, the broker and the model's own worker uid inside this container, so it
    // starts as root with the production Daimon capability set instead of the host user with no capabilities at all.
    const privilege = broker
      ? [...await trainingBrokerSecurityArgs(privateRoot), "--pids-limit", "2048",
        ...trainingBrokerTmpfsTargets(prepared.config.slots).flatMap((entry) => ["--tmpfs", `${entry.path}:rw,nosuid,nodev,size=${entry.size},mode=${entry.mode}`])]
      : ["--user", `${uid}:${gid}`, "--group-add", String(TRAINING_INPUTS_GID), "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        ...DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS, "--pids-limit", String(512 * prepared.config.slots),
        "--tmpfs", `/tmp:rw,nosuid,nodev,size=${prepared.config.slots}g,uid=${uid},gid=${gid},mode=1777`, "--tmpfs", `/work:rw,nosuid,nodev,size=${4 * prepared.config.slots}g,uid=${uid},gid=${gid},mode=700`,
        "--tmpfs", `/home/training:rw,nosuid,nodev,size=${prepared.config.slots}g,uid=${uid},gid=${gid},mode=700`];
    const args = ["create", "--name", name, "--label", `com.spawnfile.training.owner=${name}`,
      "--init", "--read-only", ...privilege,
      "--env", "HOME=/home/training", "--workdir", "/work", "--entrypoint", broker ? TRAINING_BROKER_ENTRYPOINT : "/opt/training/bin/train",
      ...(broker ? ["--env", "SPAWNFILE_TRAINING_MODEL_REQUEST_CAP=broker"] : []),
      ...evaluators.env.flatMap(value => ["--env", value]),
      ...[...mounts, ...(broker ? trainingBrokerMounts(broker) : [])].flatMap((mount) => ["--mount", mount]),
      ...(prepared.viewerPort === undefined ? [] : ["--publish", `127.0.0.1:${prepared.viewerPort}:${prepared.viewerPort}`]), expectedImage,
      "train", "--spawnfile-context", "/run/spawnfile-training/context.json",
      ...(execution ? ["--spawnfile-execution", TRAINING_EXECUTION_FILE] : []), ...prepared.args];
    creationAttempted = true;
    const created = await call(args);
    containerId = created.stdout.trim();
    if (created.code !== 0 || !/^[a-f0-9]{64}$/u.test(containerId)) {
      let diagnostic = created.stderr;
      for (const auth of [...prepared.config.auth, ...prepared.config.evaluatorSecrets ?? []]) diagnostic = diagnostic.replaceAll(auth.source, "[auth source]");
      diagnostic = diagnostic.replace(/\p{Cc}/gu, " ").trim().slice(0, 2048);
      throw Error(`Docker did not return a valid training container identity${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    const identity = await call(["inspect", "--format", inspectFormat, containerId]);
    if (identity.code !== 0 || parseDetachedContainerInspect(identity.stdout, containerId, labels, name).imageId !== expectedImage) throw Error("Training container identity mismatch");
    if (controller.signal.aborted) throw Error("Container operation cancelled");
    startAttempted = true;
    const result = await execute([...prefix, "start", "--attach", containerId], {
      timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal,
      stdout: (line) => { if (line.trim()) lastLine = line; options.streams.stdout(line); }, stderr: options.streams.stderr
    });
    const terminal = await call(["inspect", "--format", "{{json .State}}", containerId]);
    const state = JSON.parse(terminal.stdout) as { Running?: unknown; ExitCode?: unknown };
    if (terminal.code !== 0 || state.Running !== false || !Number.isInteger(state.ExitCode) || result.code !== state.ExitCode) throw Error("Training container final state is unverified");
    await outputVolume?.export();
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
    clearTimeout(timer);
    try {
      if (creationAttempted) {
        // A timed-out create may still have created our uniquely labelled container.
        const found = await call(["inspect", "--format", inspectFormat, name], true);
        if (found.code === 0) {
          const id: unknown = JSON.parse(found.stdout.split("\n")[0]!);
          if (typeof id !== "string" || parseDetachedContainerInspect(found.stdout, id, labels, name).imageId !== expectedImage || (containerId && /^[a-f0-9]{64}$/u.test(containerId) && id !== containerId)) throw Error("Refusing cleanup of unverified training container");
          try {
            if (startAttempted) {
              const current = await call(["inspect", "--format", "{{json .State}}", id], true);
              if (current.code !== 0) throw Error("Cannot verify training writer state");
              if (JSON.parse(current.stdout).Running === true) {
                const stopped = await call(["stop", "--time", "5", id], true);
                if (stopped.code !== 0) throw Error("Cannot stop training output writer");
              }
            }
            if (startAttempted && prepared.config.broker && privateRoot) {
              await persistTrainingGrokCredential(id, prepared.config.broker.bootstrap, privateRoot, call);
            }
          } finally {
            const removed = await call(["rm", "--force", id], true);
            const remaining = await call(["container", "ls", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"], true);
            if (removed.code !== 0 || remaining.code !== 0 || remaining.stdout.trim()) throw Error("Training container cleanup is unverified");
            closureVerified = true;
          }
        } else {
          const remaining = await call(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], true);
          if (remaining.code !== 0 || remaining.stdout.trim()) throw Error("Training container closure is unknown");
          closureVerified = true;
        }
      }
    } finally {
      try {
        const closed = !creationAttempted || closureVerified;
        try { if (closed) await outputVolume?.export(); }
        finally { await outputVolume?.dispose(closed); }
      } finally {
        options.signal?.removeEventListener("abort", interrupt);
        process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
        if (privateRoot && (!creationAttempted || closureVerified) && (!outputVolume || outputVolume.safeToCleanup())) await removeTrainingPreparationScratch(privateRoot);
      }
    }
  }
};
