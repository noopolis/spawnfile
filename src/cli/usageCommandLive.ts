import {
  createDockerProbeGateway,
  inspectDockerDeployment,
  listDeploymentRecords,
  type DeploymentRecord,
  type DockerInspectionResult
} from "../deployment/index.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";
import type { UsageRecord, UsageRosterEntry } from "../runtime/usageLedger.js";
import {
  readUsageLedgerViaExec,
  type UsageLedgerExec
} from "../runtime/usageLedgerRead.js";

/**
 * Transport for `spawnfile usage`.
 *
 * The ledger lives inside the container, and the host may be macOS Docker
 * Desktop or a remote Docker context, so a host-side `readFile` is impossible.
 * Reads therefore go through the sanctioned channel — the docker probe gateway,
 * which already supports `--context` / `--host` remote targets and is already
 * used to `cat` container files. `docker exec` runs as the image user (root for
 * a Daimon image), so a 0640 uid-2100 ledger is readable.
 *
 * Deferred: the stopped-container post-mortem path. `spawnfile down`
 * deliberately preserves volumes, so a stopped unit's ledger is still on disk,
 * but `docker exec` cannot reach it; the repo's `docker create` + `docker cp`
 * volume-egress pattern (`artifactsExportDocker.ts`) is the intended fallback.
 * Until it lands, a stopped unit is reported as UNREADABLE — never silently as
 * zero usage, which would misreport a dead subscription as a cheap one.
 */

/**
 * Why a unit's usage is missing.
 *
 * `stopped`/`unreachable` are decided before any read is attempted, from the
 * container inspection. `ledger_read_failed` is decided by the read itself
 * (`readUsageLedgerViaExec`) and carries the generation and bounded reason in
 * `detail`: the container was running and reachable, but one of its two ledger
 * generations could not be `cat`ed — a `maxBuffer` overrun on a rotated
 * generation, a timeout, or a daemon failure. All three mean the same thing
 * for reporting: UNKNOWN usage, never zero.
 */
export interface UsageUnitReadFailure {
  containerRef: string;
  detail?: string;
  reason: "ledger_read_failed" | "stopped" | "unreachable";
  unitId: string;
}

export interface OrganizationUsage {
  deploymentName: string;
  records: UsageRecord[];
  roster: UsageRosterEntry[];
  unreadableUnits: UsageUnitReadFailure[];
}

export interface UsageCommandLiveHandlers {
  createDockerProbeGateway?: typeof createDockerProbeGateway;
  inspectDockerDeployment?: typeof inspectDockerDeployment;
  listDeploymentRecords?: typeof listDeploymentRecords;
}

export interface CollectOrganizationUsageOptions {
  deployment?: string;
  dockerCommand?: string;
  outputDirectory: string;
  timeoutMs?: number;
}

/**
 * The org roster, from the deployment record itself.
 *
 * Engine assignment is not recorded per agent in a deployment record, so an
 * agent's engine is learned from its own ledger records. An agent that never
 * reports — every Codex agent, which is uninstrumented — keeps a `null` engine
 * and renders as a dashed row. It still counts toward the coverage denominator,
 * which is the whole point: a total computed over a partial roster must never be
 * presented as the organization's cost.
 */
export const rosterForRecord = (record: DeploymentRecord): UsageRosterEntry[] => {
  const agents = new Set<string>();
  for (const unit of record.units) {
    for (const entry of unit.contains) {
      if (entry.kind === "agent") agents.add(entry.id);
    }
  }
  return [...agents].sort().map((agent) => ({ agent, engine: null }));
};

const containerRefForUnit = (unit: DeploymentRecord["units"][number]): string =>
  unit.container_id ?? unit.container_name ?? unit.id;

export const selectUsageDeployment = (
  records: Array<{ record: DeploymentRecord }>,
  deployment?: string
): DeploymentRecord | { error: string } => {
  if (records.length === 0) {
    return { error: "No deployment records found. Run `spawnfile up` first." };
  }
  if (deployment) {
    const match = records.find((entry) => entry.record.name === deployment);
    return match
      ? match.record
      : { error: `Unknown deployment "${deployment}". Valid deployments: ${records.map((entry) => entry.record.name).sort().join(", ")}` };
  }
  if (records.length > 1) {
    return { error: `spawnfile usage requires --deployment when multiple records exist: ${records.map((entry) => entry.record.name).sort().join(", ")}` };
  }
  return records[0]!.record;
};

/**
 * Read every unit's ledger and merge the results.
 *
 * A unit that is not running is recorded as unreadable rather than read as
 * empty. A running unit whose ledger does not exist yet — the case before the
 * first turn ever completes — reads as empty, never as an error, because
 * `readUsageLedgerViaExec` treats an absent file (and only an absent file) as
 * no content. Any other read failure comes back in that reader's `unreadable`
 * list and is recorded here as a `ledger_read_failed` unit, so an unknown
 * quantity of turns is never merged into the report as zero.
 */
export const collectOrganizationUsage = async (
  options: CollectOrganizationUsageOptions,
  handlers: UsageCommandLiveHandlers = {}
): Promise<OrganizationUsage | { error: string }> => {
  const list = handlers.listDeploymentRecords ?? listDeploymentRecords;
  const inspect = handlers.inspectDockerDeployment ?? inspectDockerDeployment;
  const gatewayFor = handlers.createDockerProbeGateway ?? createDockerProbeGateway;

  const selected = selectUsageDeployment(await list(options.outputDirectory), options.deployment);
  if ("error" in selected) return selected;

  let inspections: DockerInspectionResult;
  try {
    inspections = await inspect(selected, { dockerCommand: options.dockerCommand, timeoutMs: options.timeoutMs });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const records: UsageRecord[] = [];
  const unreadableUnits: UsageUnitReadFailure[] = [];
  for (const unit of selected.units) {
    const inspection = inspections.get(unit.id);
    if (inspection?.running !== true) {
      unreadableUnits.push({
        containerRef: containerRefForUnit(unit),
        reason: inspection?.exists === false || inspection?.running === false ? "stopped" : "unreachable",
        unitId: unit.id
      });
      continue;
    }
    const gateway = gatewayFor(selected, unit, {
      dockerCommand: options.dockerCommand,
      inspection,
      timeoutMs: options.timeoutMs
    });
    const exec: UsageLedgerExec = (command) => gateway.exec(command);
    const read = await readUsageLedgerViaExec(exec, DAIMON_GROK_TURN_USAGE_LEDGER);
    records.push(...read.records);
    for (const failure of read.unreadable) {
      unreadableUnits.push({
        containerRef: containerRefForUnit(unit),
        detail: `${failure.filePath}: ${failure.reason}`,
        reason: "ledger_read_failed",
        unitId: unit.id
      });
    }
  }

  return { deploymentName: selected.name, records, roster: rosterForRecord(selected), unreadableUnits };
};
