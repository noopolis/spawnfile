import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { mapTrainingExecution, trainingExecutionIdentity, type TrainingExecution } from "../execution.js";
import type { TrainingContext } from "../contract.js";
import { trainingContainerConfigSchema } from "../container/contract.js";
import type { TrainingDockerProcess } from "../container/process.js";
import { assertTrainingSubjectIsolation } from "../container/subjectIsolation.js";
import { trainingPreparationSchema, parseTrainingMappedPreparation, type TrainingMappedPreparation } from "./contract.js";
import { assertInputRoot, exactPath, fileIdentity, hashJson, sealTree, within } from "./files.js";
import { planInputs, readBoundedJson, stageInput, verifyCanonicalPins } from "./inputs.js";
import { planTrainingImage, buildTrainingImage } from "./image.js";
import { planMeasurementRepair, stageMeasurementRepair, validateMeasurementRepairOutput, writeTrainingWitness } from "../repair/index.js";
import { prepareTrainingBroker, trainingBrokerSkills } from "./broker.js";
import { claimTrainingPreparationScratch, removeTrainingPreparationScratch } from "./scratch.js";

function mappedReceipt(digest: string, image: string, config: ReturnType<typeof trainingPreparationSchema.parse>): TrainingMappedPreparation {
  return parseTrainingMappedPreparation({ version: "spawnfile.training-preparation.v1", preparationDigest: digest, imageId: image,
    bindings: config.inputs.map(input => ({ inputId: input.id, destination: input.destination })), outputRoot: "/run/training/output",
    packagePaths: { spawnfile: "build" in config.image && config.image.build.compiler
      ? "/opt/training/compiler/dist/cli/index.js" : "/opt/training/spawnfile/dist/cli/index.js", training: "/opt/training/spawnfile/dist/training", bridge: "/opt/training/spawnfile/dist/training/dspy",
      nativeWorker: "/opt/training/spawnfile/dist/runtime/daimon/training", integration: "/opt/training/integration", bootstrap: "/opt/training/bootstrap" }, integration: config.integration });
}

export interface PrepareTrainingOptions {
  execution?: TrainingExecution; outputOverride?: string; imageOverride?: string;
  configPath: string; context: TrainingContext; args: readonly string[]; dryRun: boolean;
  process: TrainingDockerProcess; timeoutMs: number; signal?: AbortSignal;
  streams: { stdout(line: string): void; stderr(line: string): void };
  /** Test-only package fixture; production always resolves its own installed distribution. */
  packageRoot?: string;
  repairMeasurements?: string; repairWitness?: string;
}
export interface PreparedTraining {
  execution?: TrainingExecution;
  digest: string; image: string; configPath: string; preparationPath: string; repairPath?: string; context: TrainingContext; args: string[];
}

/** Reads only until the explicit dry-run boundary; preparation never executes project code. */
export async function prepareTraining(options: PrepareTrainingOptions): Promise<PreparedTraining | { digest: string; dryRun: true }> {
  const raw = await readBoundedJson(options.configPath) as Record<string, unknown>;
  const config = trainingPreparationSchema.parse({ ...raw,
    ...(options.outputOverride ? { output: { source: options.outputOverride, destination: "/run/training/output" } } : {}),
    ...(options.imageOverride ? { image: { ref: options.imageOverride } } : {}) });
  await assertTrainingSubjectIsolation(config, options.context);
  // A v2 declaration still lowers to the unchanged v1 launch config; v4 carries the broker slots into Docker.
  const launchVersion = config.version === "spawnfile.training-container.v4" ? config.version : "spawnfile.training-container.v1";
  const root = path.dirname(path.resolve(options.configPath));
  const auth = config.auth.map(entry => ({ ...entry, source: path.resolve(root, entry.source) }));
  const evaluatorSecrets = config.evaluatorSecrets?.map(entry => ({ ...entry, source: path.resolve(root, entry.source) }));
  const protectedLeaves = [...auth, ...evaluatorSecrets ?? []];
  const evaluatorConfig = { ...(config.evaluatorRoutes ? { evaluatorRoutes: config.evaluatorRoutes } : {}),
    ...(config.subjectIsolation ? { subjectIsolation: config.subjectIsolation } : {}),
    ...(evaluatorSecrets ? { evaluatorSecrets } : {}) };
  const output = path.resolve(root, config.output.source), parent = path.dirname(output);
  for (let index = 0; index < options.args.length; index++) {
    if (options.args[index] !== "--out") continue;
    const declared = options.args[++index];
    if (declared === undefined || path.resolve(declared) !== output) throw Error("Training --out must match configured output");
  }
  // Refuse invalid repair destinations before auth validation or source/witness reads.
  if (options.repairMeasurements) await validateMeasurementRepairOutput({ parent: options.repairMeasurements,
    output, resume: options.args.includes("--resume") });
  // Validate references before traversing image/input sources; aliases must never bypass secret exclusions.
  for (const entry of options.dryRun ? evaluatorSecrets ?? [] : protectedLeaves) {
    const source = await exactPath(entry.source), info = await lstat(source);
    if (source !== entry.source || !info.isFile()) throw Error("Training auth must be a canonical regular leaf");
    if (evaluatorSecrets?.includes(entry as NonNullable<typeof evaluatorSecrets>[number]) && info.nlink !== 1) throw Error("Evaluator secrets must not have hardlink aliases");
  }
  assertInputRoot(output, protectedLeaves.map(entry => entry.source));
  if (await realpath(parent) !== parent) throw Error("Training output parent must be canonical and already exist");
  const inputs = await planInputs(config, root, protectedLeaves.map(entry => entry.source));
  const canonicalPins = [...options.context.sources, ...options.execution?.datasetPins ?? []];
  const roots = inputs.map(input => input.source);
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]!;
    // A selected/Git snapshot is staged before launch; never bind the source project over its own output.
    const snapshotPaths = input.files?.map(file => path.join(input.source, file.destination))
      ?? (input.git ? [...input.git.paths, ...input.git.overlays.map(file => file.destination)].map(file => path.join(input.source, file)) : undefined);
    if (within(output, input.source) || (within(input.source, output) &&
      (!snapshotPaths || snapshotPaths.some(file => within(output, file) || within(file, output))))) {
      throw Error("Training output overlaps readonly input");
    }
    for (const other of inputs.slice(index + 1)) if (within(input.source, other.source) || within(other.source, input.source) ||
      within(input.destination, other.destination) || within(other.destination, input.destination)) throw Error("Training inputs overlap");
  }
  const imagePlan = "build" in config.image
    ? await planTrainingImage(config.image.build, root, protectedLeaves.map(entry => entry.source), options.packageRoot, path.resolve(options.configPath))
    : undefined;
  if (options.repairWitness && !options.repairMeasurements) throw Error("A repair witness requires --repair-measurements");
  if (options.repairMeasurements && !imagePlan) throw Error("Measurement repair requires a verifiable image build recipe");
  const repair = options.repairMeasurements ? await planMeasurementRepair({ parent: options.repairMeasurements,
    witness: options.repairWitness, output, auth: protectedLeaves.map(entry => entry.source), image: imagePlan!, inputs,
    context: options.context, resume: options.args.includes("--resume") }) : undefined;
  if (repair && hashJson(config.integration) !== hashJson(repair.witness.manifest.config.integration)) throw Error("Repair integration settings binding changed");
  const digest = hashJson({ config, sources: inputs.map(input => ({ id: input.id, digest: input.digest })), image: imagePlan?.digest ?? config.image,
    canonical: options.context.project.sourceDigest,
    ...(options.execution ? { execution: trainingExecutionIdentity(options.execution) } : {}), ...(repair ? { repair: { witness: repair.witness.digest, parent: repair.manifestDigest } } : {}) });
  const brokerSkills = config.broker ? await trainingBrokerSkills(options.context) : undefined;
  if (config.broker) await prepareTrainingBroker(config.broker, root, path.dirname(path.resolve(options.configPath)), false, config.slots, brokerSkills);
  if (options.dryRun) return { digest, dryRun: true };
  options.signal?.throwIfAborted();
  const execute = (args: string[]) => options.process(args, { timeoutMs: options.timeoutMs, signal: options.signal });
  const endpoint = await execute(["context", "inspect", config.dockerContext, "--format", "{{json .Endpoints.docker.Host}}"]);
  if (endpoint.code !== 0 || !/^unix:\/\//u.test(JSON.parse(endpoint.stdout))) throw Error("Training preparation requires a local Unix Docker context");
  if (repair) {
    const label = await execute(["--context", config.dockerContext, "image", "inspect", repair.witness.manifest.parentImage,
      "--format", '{{json .Id}}\n{{json (index .Config.Labels "com.spawnfile.training.recipe")}}']);
    const values = label.stdout.trim().split("\n").map(value => JSON.parse(value));
    if (label.code !== 0 || values[0] !== repair.witness.manifest.parentImage || values[1] !== repair.witness.manifest.imagePlanDigest) throw Error("Parent image recipe witness is unverified");
  }
  const staging = path.join(parent, `.spawnfile-training-preparation-${hashJson(output).slice(7, 23)}`);
  const configPath = path.join(staging, "launch.json"), preparationPath = path.join(staging, "mapped.json"), statePath = path.join(staging, "state.json");
  const resume = options.args.includes("--resume");
  let image: string, staged: string[];
  if (resume) {
    await claimTrainingPreparationScratch(staging, digest, options.streams.stderr, "resume");
    const previous = JSON.parse(await readFile(statePath, "utf8")) as { digest: string; image: string; staged: string[]; snapshots: (string | null)[] };
    if (previous.digest !== digest || !/^sha256:[a-f0-9]{64}$/u.test(previous.image) ||
      JSON.stringify(previous.staged) !== JSON.stringify(inputs.map(input => input.git || input.files ? path.join(staging, input.id) : input.source))) throw Error("Training preparation changed; exact resume rejected");
    image = previous.image; staged = previous.staged;
    const snapshots = await Promise.all(inputs.map(async (input, index) => input.git || input.files ? hashJson(fileIdentity(await sealTree(staged[index]!, "input", { ignoreGit: true, internalSymlinks: true }))) : null));
    if (JSON.stringify(previous.snapshots) !== JSON.stringify(snapshots)) throw Error("Persisted training input snapshot changed");
    const mapped = parseTrainingMappedPreparation(await readBoundedJson(preparationPath));
    if (mapped.preparationDigest !== digest || mapped.imageId !== image) throw Error("Persisted training preparation identity mismatch");
    await verifyCanonicalPins(inputs, canonicalPins, staged);
  } else {
    let owned = false;
    try {
      await claimTrainingPreparationScratch(staging, digest, options.streams.stderr); owned = true;
      try { await mkdir(output, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(output)).isDirectory() || await realpath(output) !== output) throw error; }
      // Do not remove owned staging while sibling input jobs can still write into it.
      const results = await Promise.allSettled(inputs.map(input => stageInput(input, path.join(staging, input.id))));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      staged = results.map(result => (result as PromiseFulfilledResult<string>).value);
      await verifyCanonicalPins(inputs, canonicalPins, staged);
      image = imagePlan ? (await buildTrainingImage(imagePlan, { parent, dockerContext: config.dockerContext, process: options.process,
        timeoutMs: options.timeoutMs, signal: options.signal, streams: options.streams })).imageId : "ref" in config.image ? config.image.ref : "";
      if (!image.startsWith("sha256:")) {
        const inspected = await execute(["--context", config.dockerContext, "image", "inspect", image, "--format", "{{.Id}}"]);
        if (inspected.code !== 0) throw Error("Training image is unavailable"); image = inspected.stdout.trim();
      }
      const mapped = mappedReceipt(digest, image, config);
      const preparedBroker = config.broker ? await prepareTrainingBroker(config.broker, root, staging, true, config.slots, brokerSkills) : undefined;
      const launch = trainingContainerConfigSchema.parse({ version: launchVersion, slots: config.slots, dockerContext: config.dockerContext,
        inputs: inputs.map((input, index) => ({ source: staged[index], destination: input.destination })), output: { source: output, destination: "/run/training/output" }, auth, ...evaluatorConfig,
        ...(preparedBroker ? { broker: preparedBroker.launch } : {}) });
      await writeFile(configPath, JSON.stringify(launch), { flag: "wx", mode: 0o600 });
      await writeFile(preparationPath, JSON.stringify(parseTrainingMappedPreparation(mapped)), { flag: "wx", mode: 0o400 });
      const snapshots = await Promise.all(inputs.map(async (input, index) => input.git || input.files ? hashJson(fileIdentity(await sealTree(staged[index]!, "input", { ignoreGit: true, internalSymlinks: true }))) : null));
      await writeFile(statePath, JSON.stringify({ digest, image, staged, snapshots }), { flag: "wx", mode: 0o600 });
      if (imagePlan) await writeTrainingWitness({ directory: staging, digest, image, config, context: options.context,
        args: options.args, execution: options.execution, inputs, staged, snapshots, plan: imagePlan,
        ...(repair ? { repair: { witness: repair.witness.digest, parent: repair.manifestDigest } } : {}) });
    } catch (error) { if (owned) await removeTrainingPreparationScratch(staging); throw error; }
  }
  const expectedBroker = config.broker ? await prepareTrainingBroker(config.broker, root, staging, false, config.slots, brokerSkills) : undefined;
  const expectedLaunch = trainingContainerConfigSchema.parse({ version: launchVersion, slots: config.slots, dockerContext: config.dockerContext,
    inputs: inputs.map((input, index) => ({ source: staged[index], destination: input.destination })), output: { source: output, destination: "/run/training/output" }, auth, ...evaluatorConfig,
    ...(expectedBroker ? { broker: expectedBroker.launch } : {}) });
  if (hashJson(await readBoundedJson(configPath)) !== hashJson(expectedLaunch) ||
    hashJson(await readBoundedJson(preparationPath)) !== hashJson(mappedReceipt(digest, image, config))) throw Error("Saved training launch or mapped receipt changed");
  const inspected = await execute(["--context", config.dockerContext, "image", "inspect", image, "--format", "{{.Id}}"]);
  if (inspected.code !== 0 || inspected.stdout.trim() !== image) throw Error("Saved training image is missing or changed");
  const map = (file: string): string => {
    const absolute = path.resolve(file);
    if (within(output, absolute)) return absolute;
    const index = roots.findIndex(source => within(source, absolute));
    return index < 0 ? absolute : path.join(staged[index]!, path.relative(roots[index]!, absolute));
  };
  const context: TrainingContext = { ...options.context,
    project: { ...options.context.project, root: map(options.context.project.root), manifest: map(options.context.project.manifest) },
    agent: { ...options.context.agent, source: map(options.context.agent.source) },
    sources: options.context.sources.map(source => ({ ...source, sourcePath: map(source.sourcePath) })),
    documents: options.context.documents.map(source => ({ ...source, sourcePath: map(source.sourcePath) })),
    skills: options.context.skills.map(source => ({ ...source, sourcePath: map(source.sourcePath) })) };
  const args = [...options.args];
  for (let index = 0; index < args.length; index++) {
    if (["--train", "--validation", "--test", "--cost-config"].includes(args[index]!)) args[++index] = map(args[index]!);
    else if (args[index] === "--resource") { const value = args[++index]!, split = value.indexOf("="); args[index] = `${value.slice(0, split)}=${map(value.slice(split + 1))}`; }
  }
  if (repair) {
    const projected = await stageMeasurementRepair(repair, staging, image, options.context.project.sourceDigest, resume);
    const repairLaunch = { ...expectedLaunch, inputs: [...expectedLaunch.inputs,
      { source: projected.root, destination: "/run/training/inputs/repair-parent" }] };
    const repairConfig = path.join(staging, "repair-launch.json");
    if (resume) {
      if (hashJson(await readBoundedJson(repairConfig)) !== hashJson(repairLaunch)) throw Error("Saved repair launch changed");
    } else await writeFile(repairConfig, JSON.stringify(repairLaunch), { flag: "wx", mode: 0o600 });
    return { digest, image, configPath: repairConfig, preparationPath, repairPath: projected.repairPath, context,
      ...(options.execution ? { execution: mapTrainingExecution(options.execution, map) } : {}),
      args: [...args, "--repair-measurements", "/run/training/inputs/repair-parent", "--repair-context", "/run/paideia/repair.json"] };
  }
  return { digest, image, configPath, preparationPath, context, args,
    ...(options.execution ? { execution: mapTrainingExecution(options.execution, map) } : {}) };
}
