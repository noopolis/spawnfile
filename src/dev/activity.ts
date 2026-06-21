import {
  defaultExecFile,
  dockerArgsForRecord,
  firstContainerName,
  runDocker,
  type DevExecFile
} from "./docker.js";
import {
  PI_CONTROL_URL,
  resolveDevOutputDirectory,
  selectDeploymentRecord,
  type DevProjectOptions
} from "./project.js";
import { SpawnfileError } from "../shared/index.js";

export interface DevActivityProjectOptions extends DevProjectOptions {
  agent?: string;
  execFile?: DevExecFile;
  tail?: number;
}

export interface DevActivityProjectResult {
  containerName: string;
  deploymentName: string;
  events: unknown[];
  outputDirectory: string;
}

const activityPath = (options: DevActivityProjectOptions): string => {
  const params = new URLSearchParams();
  if (options.agent) {
    params.set("agent", options.agent);
  }
  if (typeof options.tail === "number" && Number.isInteger(options.tail) && options.tail > 0) {
    params.set("tail", String(options.tail));
  }
  const query = params.toString();
  return `${PI_CONTROL_URL}/spawnfile/activity${query ? `?${query}` : ""}`;
};

const parseActivityEvents = (stdout: string): unknown[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SpawnfileError("runtime_error", "Pi activity endpoint returned invalid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { events?: unknown }).events)
  ) {
    throw new SpawnfileError("runtime_error", "Pi activity endpoint response did not include an events array");
  }
  return (parsed as { events: unknown[] }).events;
};

export const devActivityProject = async (
  inputPath: string,
  options: DevActivityProjectOptions = {}
): Promise<DevActivityProjectResult> => {
  const outputDirectory = await resolveDevOutputDirectory(inputPath, options.outputDirectory);
  const record = await selectDeploymentRecord(outputDirectory, options.deploymentName);
  const containerName = firstContainerName(record);
  const stdout = await runDocker(
    options.dockerCommand ?? "docker",
    [
      ...dockerArgsForRecord(record),
      "exec",
      containerName,
      "curl",
      "-fsS",
      activityPath(options)
    ],
    options.execFile ?? defaultExecFile
  );
  return {
    containerName,
    deploymentName: record.name,
    events: parseActivityEvents(stdout),
    outputDirectory
  };
};
