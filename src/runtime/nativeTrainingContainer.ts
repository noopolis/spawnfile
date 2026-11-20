import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ResolvedAuthProfile } from "../auth/index.js";
import { buildCompiledProject, compileProject, createDockerRunInvocation, executeDockerRunWithSupportCleanup,
  resolveDeploymentLineage, runDockerContainer } from "../compiler/index.js";
import { trainingMomentSchema, type TrainingContext } from "../compiler/training/index.js";
import { createTrialDocker, fillMomentVolumes, isolateTrainingVolumes, momentVolumesFor, waitFor, writeTrialProject, type TrialDocker } from "../compiler/training/trial/index.js";
import type { SubjectStart } from "./trainingTypes.js";
import { ensureNoopolisRunId } from "./common.js";
import { nativeInputSync, readNativeFile } from "./nativeTrainingFiles.js";
import type { NativeTrainingTrial } from "./nativeTrainingSubject.js";
import { getRuntimeAdapter } from "./registry.js";

const probePort = "const s = require('node:net').connect(Number(process.argv[1]), '127.0.0.1'); s.setTimeout(1000); s.on('connect', () => s.end()); s.on('error', () => process.exit(1)); s.on('timeout', () => process.exit(1));";

export async function bootNativeTrainingTrial(context: TrainingContext, profile: ResolvedAuthProfile | null, input: SubjectStart,
  docker: TrialDocker = createTrialDocker()): Promise<NativeTrainingTrial> {
  input.signal?.throwIfAborted();
  const moment = input.setup?.moment === undefined ? undefined : trainingMomentSchema.parse(input.setup.moment);
  const slug = randomUUID(), container = `spawnfile-training-${slug}`, image = `spawnfile-training:${slug}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-native-trial-"));
  let built = false, starting = false, supportDirectory: string | undefined;
  let volumes: string[] = [];
  const cleanup = async (): Promise<void> => {
    const containerRemoval = starting ? await Promise.allSettled([docker(["rm", "-f", container])]) : [];
    const removals = await Promise.allSettled([
      ...volumes.map(volume => docker(["volume", "rm", "-f", volume])),
      ...(built ? [docker(["image", "rm", image])] : []),
      ...(supportDirectory ? [rm(supportDirectory, { force: true, recursive: true })] : []),
      rm(directory, { force: true, recursive: true })
    ]);
    const failures = [...containerRemoval, ...removals].flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Could not remove all training trial resources");
  };
  try {
    ensureNoopolisRunId();
    const project = await writeTrialProject(context.project.manifest, context.agent.source, input.instructions, path.join(directory, "project"));
    const compiled = await compileProject(project.manifestPath, {
      deploymentLineage: resolveDeploymentLineage(slug, "training"), manifestOverrides: project.manifestOverrides, outputDirectory: path.join(directory, "out")
    });
    const report = compiled.report.container;
    const instance = report?.runtime_instances.find(entry => entry.runtime === context.agent.runtime && entry.node_ids?.includes(context.agent.id));
    if (!instance?.home_path || !instance.workspace_path || !report || report.runtime_instances.length !== 1) {
      throw new Error(`Expected one compiled training instance for ${context.agent.id}`);
    }
    const { config_path: configPath, home_path: homePath, workspace_path: workspacePath } = instance;
    const adapter = getRuntimeAdapter(context.agent.runtime);
    const meta = adapter.container;
    const environment: Record<string, string> = { ...meta.staticEnv, HOME: homePath };
    if (meta.homeEnv) environment[meta.homeEnv] = homePath;
    if (meta.configPathEnv) environment[meta.configPathEnv] = configPath;
    if (instance.internal_port && meta.portEnv) environment[meta.portEnv] = String(instance.internal_port);
    if (Object.values(instance.model_auth_methods).includes("codex")) environment.CODEX_HOME = path.posix.join(homePath, ".codex");
    input.signal?.throwIfAborted();
    await buildCompiledProject(project.manifestPath, compiled, { imageTag: image });
    built = true;
    input.signal?.throwIfAborted();
    isolateTrainingVolumes(report, slug);
    volumes = (report.persistent_mounts ?? []).map(mount => mount.volume_name);
    // The harness is reached from inside its container. Parallel trials need no host ports.
    report.ports = [];
    const invocation = await createDockerRunInvocation(compiled, image, {
      authProfile: profile, containerName: container, deploymentName: slug, detach: true
    });
    supportDirectory = invocation.supportDirectory;
    if (moment) await fillMomentVolumes(docker, image, momentVolumesFor(moment, report), "spawnfile");
    input.signal?.throwIfAborted();
    starting = true;
    await executeDockerRunWithSupportCleanup(invocation, runDockerContainer);
    const port = instance.internal_port;
    if (port) {
      await waitFor(async () => {
        input.signal?.throwIfAborted();
        if (await docker(["inspect", "--format", "{{.State.Running}} {{.RestartCount}}", container]) !== "true 0") {
          throw new Error("Training container exited before the harness became ready");
        }
        return docker(["exec", container, "node", "-e", probePort, String(port)], { signal: input.signal }).then(() => true, () => false);
      }, 180_000, "Training harness startup");
    }
    for (const step of moment?.afterBoot ?? []) {
      await docker(["exec", "--user", step.user, ...Object.entries(step.env ?? {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
        container, ...step.command], { signal: input.signal });
    }
    input.signal?.throwIfAborted();
    const outputRoots = [workspacePath, ...(report.workspace_resources ?? []).map(resource => resource.backing_path)];
    return {
      instance: {
        configPath, homePath, workspacePath,
        exec: (argv, options = {}) => {
          const env = Object.entries({ ...environment, ...options.env }).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
          return docker(["exec", "--user", "spawnfile", "--workdir", workspacePath, ...env, container, ...argv],
            { preserveWhitespace: true, signal: options.signal, timeoutMs: options.timeoutMs });
        },
        readFile: file => readNativeFile(docker, container, file, [homePath, workspacePath])
      },
      readOutput: file => readNativeFile(docker, container, path.posix.join(workspacePath, file), outputRoots),
      syncInputs: nativeInputSync(docker, container, input.workspacePath, workspacePath),
      close: cleanup
    };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Training startup and cleanup failed"); }
    throw error;
  }
}
