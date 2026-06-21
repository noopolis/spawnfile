import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  buildCompilePlan,
  type CompileProjectResult,
  upProject,
  type UpProjectOptions,
  type UpProjectResult
} from "../compiler/index.js";
import {
  listDeploymentRecords,
  normalizeDeploymentName,
  type DeploymentRecord
} from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";
import {
  chownContainerPaths,
  compileForDevApply,
  copyIntoContainer,
  defaultExecFile,
  dockerArgsForRecord,
  ensureContainerDirectories,
  firstContainerName,
  runDocker,
  type DevExecFile
} from "./docker.js";

const DEV_OUTPUT_DIRECTORY = ".spawn-dev";
const PI_APP_CONFIG_PATH = "/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json";
const PI_CONTROL_URL = "http://127.0.0.1:19690";

export interface DevProjectOptions {
  deploymentName?: string;
  dockerCommand?: string;
  outputDirectory?: string;
}

export interface DevApplyProjectOptions extends DevProjectOptions {
  agent: string;
  execFile?: DevExecFile;
  restart?: boolean;
}

export interface DevApplyProjectResult {
  agentId: string;
  bridgeStarted: boolean;
  containerName: string;
  deploymentName: string;
  existingAgent: boolean;
  outputDirectory: string;
}

export interface DevStopProjectResult {
  containerName: string;
  deploymentName: string;
  outputDirectory: string;
}

interface PiAgentConfig {
  id: string;
  name: string;
  slug: string;
}

interface MoltnetNodeConfig {
  attachments?: Array<{
    agent?: { id?: string; name?: string };
    moltnet?: { token_env?: string; token_path?: string };
  }>;
}

interface MoltnetServerPlan {
  config_path?: string;
  mode?: string;
}

const resolveDevOutputDirectory = async (
  inputPath: string,
  outputDirectory?: string
): Promise<string> => {
  if (outputDirectory) {
    return path.resolve(outputDirectory);
  }
  const plan = await buildCompilePlan(inputPath);
  return path.join(path.dirname(plan.root), DEV_OUTPUT_DIRECTORY);
};

export const devUpProject = async (
  inputPath: string,
  options: UpProjectOptions = {}
): Promise<UpProjectResult> => upProject(inputPath, {
  ...options,
  detach: true,
  outputDirectory: await resolveDevOutputDirectory(inputPath, options.outputDirectory)
});

const selectDeploymentRecord = async (
  outputDirectory: string,
  deploymentName?: string
): Promise<DeploymentRecord> => {
  const records = await listDeploymentRecords(outputDirectory);
  if (records.length === 0) {
    throw new SpawnfileError(
      "validation_error",
      `No dev deployment records found in ${outputDirectory}; run spawnfile dev up first`
    );
  }
  if (deploymentName) {
    const normalized = normalizeDeploymentName(deploymentName);
    const selected = records.find((entry) => entry.record.name === normalized);
    if (!selected) {
      throw new SpawnfileError(
        "validation_error",
        `Unknown dev deployment "${normalized}". Valid deployments: ${records.map((entry) => entry.record.name).join(", ")}`
      );
    }
    return selected.record;
  }
  if (records.length > 1) {
    throw new SpawnfileError(
      "validation_error",
      `--deployment is required: ${records.map((entry) => entry.record.name).join(", ")}`
    );
  }
  return records[0]!.record;
};

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

const rootfsPath = (outputDirectory: string, containerPath: string): string =>
  path.join(outputDirectory, "container", "rootfs", containerPath.replace(/^\/+/u, ""));

const matchesAgent = (agent: PiAgentConfig, input: string): boolean =>
  agent.slug === input || agent.id === input || agent.name === input || agent.id === `agent:${input}`;

const selectPiAgent = async (
  outputDirectory: string,
  agentInput: string
): Promise<{ agent: PiAgentConfig; configPath: string; workspacePath: string }> => {
  const configPath = rootfsPath(outputDirectory, PI_APP_CONFIG_PATH);
  const config = await readJson<{ agents?: PiAgentConfig[] }>(configPath);
  const agent = (config.agents ?? []).find((candidate) => matchesAgent(candidate, agentInput));
  if (!agent) {
    throw new SpawnfileError("validation_error", `Pi agent "${agentInput}" was not found in compiled output`);
  }
  return {
    agent,
    configPath,
    workspacePath: rootfsPath(
      outputDirectory,
      `/var/lib/spawnfile/instances/pi/pi-app/workspace/agents/${agent.slug}`
    )
  };
};

interface SelectedMoltnetNode {
  configPath: string;
  remotePath: string;
  tokenDirectory?: string;
}

const selectMoltnetNodes = async (
  result: CompileProjectResult,
  agent: PiAgentConfig
): Promise<SelectedMoltnetNode[]> => {
  const nodePlans = result.report.container?.moltnet?.node_plans ?? [];
  const matches: SelectedMoltnetNode[] = [];
  for (const plan of nodePlans) {
    const configPath = rootfsPath(result.outputDirectory, plan.config_path);
    const config = await readJson<MoltnetNodeConfig>(configPath);
    const attachment = (config.attachments ?? []).find((candidate) => {
      const id = candidate.agent?.id ?? "";
      const name = candidate.agent?.name ?? "";
      return id === agent.slug || id === agent.id || name === agent.name;
    });
    if (attachment?.agent?.id) {
      matches.push({
        configPath,
        remotePath: plan.config_path,
        ...(attachment.moltnet?.token_path
          ? { tokenDirectory: path.posix.dirname(attachment.moltnet.token_path) }
          : {})
      });
    }
  }
  return matches;
};

const selectManagedMoltnetServers = (result: CompileProjectResult): Array<{ configPath: string; remotePath: string }> =>
  (result.report.container?.moltnet?.server_plans ?? [])
    .filter((plan: MoltnetServerPlan) => plan.mode === "managed" && Boolean(plan.config_path))
    .map((plan: MoltnetServerPlan) => ({
      configPath: rootfsPath(result.outputDirectory, plan.config_path!),
      remotePath: plan.config_path!
    }));

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const listRunningPiAgents = async (
  dockerCommand: string,
  dockerPrefix: string[],
  containerName: string,
  execFileImpl: DevExecFile
): Promise<PiAgentConfig[]> => {
  const stdout = await runDocker(
    dockerCommand,
    [...dockerPrefix, "exec", containerName, "curl", "-fsS", `${PI_CONTROL_URL}/spawnfile/agents`],
    execFileImpl
  );
  const parsed = JSON.parse(stdout) as { agents?: PiAgentConfig[] };
  return parsed.agents ?? [];
};

const loadPiAgent = async (
  dockerCommand: string,
  dockerPrefix: string[],
  containerName: string,
  slug: string,
  action: "load" | "restart",
  execFileImpl: DevExecFile
): Promise<void> => {
  await runDocker(
    dockerCommand,
    [
      ...dockerPrefix,
      "exec",
      containerName,
      "curl",
      "-fsS",
      "-X",
      "POST",
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify({ slug }),
      `${PI_CONTROL_URL}/spawnfile/agents/${action}`
    ],
    execFileImpl,
    120_000
  );
};

export const devApplyProject = async (
  inputPath: string,
  options: DevApplyProjectOptions
): Promise<DevApplyProjectResult> => {
  const outputDirectory = await resolveDevOutputDirectory(inputPath, options.outputDirectory);
  const record = await selectDeploymentRecord(outputDirectory, options.deploymentName);
  const dockerCommand = options.dockerCommand ?? "docker";
  const dockerPrefix = dockerArgsForRecord(record);
  const containerName = firstContainerName(record);
  const execFileImpl = options.execFile ?? defaultExecFile;
  const existingAgents = await listRunningPiAgents(dockerCommand, dockerPrefix, containerName, execFileImpl);
  const compileResult = await compileForDevApply(
    inputPath,
    outputDirectory,
    record,
    dockerCommand,
    execFileImpl
  );
  const { agent, configPath, workspacePath } = await selectPiAgent(outputDirectory, options.agent);
  const nodes = await selectMoltnetNodes(compileResult, agent);
  const serverConfigs = selectManagedMoltnetServers(compileResult);
  const existingAgent = existingAgents.some((candidate) => matchesAgent(candidate, agent.slug));

  await copyIntoContainer(dockerCommand, dockerPrefix, configPath, `${containerName}:${PI_APP_CONFIG_PATH}`, execFileImpl);
  await copyIntoContainer(
    dockerCommand,
    dockerPrefix,
    workspacePath,
    `${containerName}:/var/lib/spawnfile/instances/pi/pi-app/workspace/agents`,
    execFileImpl
  );
  for (const node of nodes) {
    await copyIntoContainer(dockerCommand, dockerPrefix, node.configPath, `${containerName}:${node.remotePath}`, execFileImpl);
  }
  for (const serverConfig of serverConfigs) {
    await copyIntoContainer(
      dockerCommand,
      dockerPrefix,
      serverConfig.configPath,
      `${containerName}:${serverConfig.remotePath}`,
      execFileImpl
    );
  }
  const tokenDirectories = nodes
    .map((node) => node.tokenDirectory)
    .filter((directory): directory is string => Boolean(directory));
  await ensureContainerDirectories(
    dockerCommand,
    dockerPrefix,
    containerName,
    tokenDirectories,
    execFileImpl
  );
  await chownContainerPaths(dockerCommand, dockerPrefix, containerName, [
    "/var/lib/spawnfile/instances/pi/pi-app",
    ...nodes.flatMap((node) => [
      node.remotePath,
      ...(node.tokenDirectory ? [node.tokenDirectory] : [])
    ]),
    ...serverConfigs.map((serverConfig) => serverConfig.remotePath)
  ], execFileImpl);
  await loadPiAgent(
    dockerCommand,
    dockerPrefix,
    containerName,
    agent.slug,
    options.restart === true ? "restart" : "load",
    execFileImpl
  );

  if (!existingAgent) {
    for (const node of nodes) {
      const prepare = node.tokenDirectory ? `mkdir -p ${shellQuote(node.tokenDirectory)} && ` : "";
      const command = `${prepare}/usr/local/bin/moltnet node ${shellQuote(node.remotePath)}`;
      await runDocker(
        dockerCommand,
        [...dockerPrefix, "exec", "-d", "--user", "spawnfile", containerName, "sh", "-lc", command],
        execFileImpl
      );
    }
  }

  return {
    agentId: agent.id,
    bridgeStarted: !existingAgent && nodes.length > 0,
    containerName,
    deploymentName: record.name,
    existingAgent,
    outputDirectory
  };
};

export const devRestartProject = async (
  inputPath: string,
  options: DevApplyProjectOptions
): Promise<DevApplyProjectResult> => devApplyProject(inputPath, { ...options, restart: true });

export const devStopProject = async (
  inputPath: string,
  options: DevProjectOptions & { execFile?: DevExecFile } = {}
): Promise<DevStopProjectResult> => {
  const outputDirectory = await resolveDevOutputDirectory(inputPath, options.outputDirectory);
  const record = await selectDeploymentRecord(outputDirectory, options.deploymentName);
  const containerName = firstContainerName(record);
  await runDocker(
    options.dockerCommand ?? "docker",
    [...dockerArgsForRecord(record), "rm", "-f", containerName],
    options.execFile ?? defaultExecFile
  );
  return { containerName, deploymentName: record.name, outputDirectory };
};
