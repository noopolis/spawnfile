import { runCli } from "../cli/runCli.js";
import { SpawnfileError } from "../shared/index.js";
import type { OperationalSmokeLogger } from "./operationalSmoke.js";

interface StatusJsonObservation {
  key: string;
  severity: string;
  source: string;
  subject: string;
}

interface StatusJsonUnit {
  id: string;
  live?: {
    checked?: boolean;
    running?: boolean | null;
    severity?: string;
  } | null;
}

interface StatusJson {
  deployments?: Array<{
    units?: StatusJsonUnit[];
  }>;
  observations?: StatusJsonObservation[];
}

const parseStatusJson = (lines: string[]): StatusJson => {
  try {
    return JSON.parse(lines.join("\n")) as StatusJson;
  } catch (error) {
    throw new SpawnfileError(
      "runtime_error",
      `spawnfile status --live --json returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

const requireObservation = (
  status: StatusJson,
  expected: Pick<StatusJsonObservation, "key" | "severity" | "source" | "subject">
): void => {
  const found = (status.observations ?? []).some((observation) =>
    observation.key === expected.key
    && observation.severity === expected.severity
    && observation.source === expected.source
    && observation.subject === expected.subject
  );
  if (!found) {
    throw new SpawnfileError(
      "runtime_error",
      `spawnfile status --live missing ${expected.severity} ${expected.source} observation ${
        expected.subject
      } ${expected.key}`
    );
  }
};

const assertDeploymentUnit = (status: StatusJson): void => {
  const units = (status.deployments ?? []).flatMap((deployment) => deployment.units ?? []);
  const runningUnit = units.find((unit) =>
    unit.id === "default-container"
    && unit.live?.checked === true
    && unit.live.running === true
    && unit.live.severity === "ok"
  );
  if (!runningUnit) {
    throw new SpawnfileError(
      "runtime_error",
      "spawnfile status --live did not confirm the default deployment container is running"
    );
  }
};

const assertOperationalStatus = (status: StatusJson): void => {
  assertDeploymentUnit(status);
  for (const expected of [
    {
      key: "runtime.health",
      severity: "ok",
      source: "runtime",
      subject: "runtime-instance:agent-pico-scheduled"
    },
    {
      key: "runtime.ready",
      severity: "ok",
      source: "runtime",
      subject: "runtime-instance:agent-pico-scheduled"
    },
    {
      key: "schedule.next_run",
      severity: "ok",
      source: "runtime",
      subject: "runtime-instance:agent-pico-scheduled"
    },
    {
      key: "network.reachable",
      severity: "ok",
      source: "network",
      subject: "network:ops_lab"
    },
    {
      key: "network.room",
      severity: "ok",
      source: "network",
      subject: "room:ops_lab:ops-room"
    },
    {
      key: "network.agent.connected",
      severity: "ok",
      source: "network",
      subject: "agent:pico-scheduled"
    }
  ]) {
    requireObservation(status, expected);
  }
};

export const assertOperationalSmokeStatusLive = async (
  input: {
    fixtureDirectory: string;
    logger: OperationalSmokeLogger;
    outputDirectory: string;
  },
  deps: {
    runCli: typeof runCli;
  }
): Promise<void> => {
  const stdout: string[] = [];
  const exitCode = await deps.runCli([
    "status",
    input.fixtureDirectory,
    "--out",
    input.outputDirectory,
    "--live",
    "--deployment",
    "default",
    "--json"
  ], {
    stderr: (message) => input.logger.info(`spawnfile status stderr: ${message}`),
    stdout: (message) => {
      stdout.push(message);
      input.logger.info(`spawnfile status: ${message}`);
    }
  });

  if (exitCode !== 0) {
    throw new SpawnfileError("runtime_error", `spawnfile status --live exited with code ${exitCode}`);
  }
  assertOperationalStatus(parseStatusJson(stdout));
};
