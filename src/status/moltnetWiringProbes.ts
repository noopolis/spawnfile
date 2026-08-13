import path from "node:path";

import type {
  LoadedCompileReport,
  StatusReportMoltnetNodePlan,
  StatusReportMoltnetServerPlan
} from "./compileReport.js";
import type { StatusObservation } from "./types.js";

/**
 * Offline Moltnet-wiring cross-check probes (B38). A pure reader over the
 * already-loaded compile report plus an injected `readFile` (same
 * injected-read style as its sibling `src/status/lifecycleProbes.ts`) so
 * this stays hermetic for both `status --out <dir>` (real filesystem) and the
 * home-deployment path (no compiled output tree; readFile always resolves
 * `null`). Same cardinal rule as `src/status/lifecycleProbes.ts` and
 * `src/audit/`: absent input is `unknown`, never `ok`.
 */
export type MoltnetWiringReadFile = (filePath: string) => Promise<string | null>;

export interface CollectMoltnetWiringProbeOptions {
  loadedReport: LoadedCompileReport;
  /** Compiled output directory to resolve node config files under `container/rootfs`. `null` when there is no compiled output tree (home-deployment status). */
  outputDirectory: string | null;
  readFile: MoltnetWiringReadFile;
}

const CONTAINER_ROOTFS_ROOT = "container/rootfs";
const MOLTNET_NODE_CONFIG_VERSION = "moltnet.node.v1";
// src/compiler/moltnetRuntimeConfig.ts:108 — pi/daimon attachments both lower to kind "pi".
const CONTROL_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/agents\/[a-z0-9-]+\/wake$/u;

const WIRING_KEYS = [
  "network.wiring.node_config",
  "network.wiring.control_url",
  "network.wiring.network_resolves",
  "network.wiring.membership"
] as const;

interface ParsedMoltnetAttachmentRuntime {
  config_path?: unknown;
  control_url?: unknown;
  kind?: unknown;
}

interface ParsedMoltnetAttachment {
  agent?: { id?: unknown };
  runtime?: ParsedMoltnetAttachmentRuntime;
}

interface ParsedMoltnetNodeConfig {
  attachments?: ParsedMoltnetAttachment[];
  version?: unknown;
}

interface ReadNodePlan {
  networkId: string;
  parsed: ParsedMoltnetNodeConfig | null;
  physicalPath: string | null;
}

const createObservation = (
  input: Omit<StatusObservation, "label" | "source">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`,
  source: "compile_report"
});

const missingReportObservations = (): StatusObservation[] =>
  WIRING_KEYS.map((key) => createObservation({
    key,
    message: `${key} was not checked: no compile report is available`,
    severity: "unknown",
    subject: "compile"
  }));

// node_plans[].config_path is a container-absolute path
// (toContainerRootfsPath, src/compiler/moltnetArtifactPaths.ts) — the
// physical file on disk lives under the compiled output's rootfs mirror.
const nodeConfigPhysicalPath = (outputDirectory: string, configPath: string): string =>
  path.join(outputDirectory, CONTAINER_ROOTFS_ROOT, configPath);

const readNodePlans = async (
  nodePlans: StatusReportMoltnetNodePlan[],
  outputDirectory: string | null,
  readFile: MoltnetWiringReadFile
): Promise<ReadNodePlan[]> =>
  Promise.all(nodePlans.map(async (plan): Promise<ReadNodePlan> => {
    if (!outputDirectory) {
      return { networkId: plan.networkId, parsed: null, physicalPath: null };
    }

    const physicalPath = nodeConfigPhysicalPath(outputDirectory, plan.configPath);
    const content = await readFile(physicalPath);
    if (content === null) {
      return { networkId: plan.networkId, parsed: null, physicalPath };
    }

    try {
      return { networkId: plan.networkId, parsed: JSON.parse(content) as ParsedMoltnetNodeConfig, physicalPath };
    } catch {
      return { networkId: plan.networkId, parsed: null, physicalPath };
    }
  }));

const isValidNodeConfig = (plan: ReadNodePlan): boolean =>
  plan.parsed !== null && plan.parsed.version === MOLTNET_NODE_CONFIG_VERSION;

const collectNodeConfigObservations = (plans: ReadNodePlan[]): StatusObservation[] =>
  plans.map((plan) => {
    const subject = `network:${plan.networkId}`;
    if (!plan.physicalPath) {
      return createObservation({
        key: "network.wiring.node_config",
        message: `${plan.networkId} node config has no compiled output directory to read from`,
        severity: "unknown",
        subject
      });
    }
    if (plan.parsed === null) {
      return createObservation({
        key: "network.wiring.node_config",
        message: `${plan.networkId} node config at ${plan.physicalPath} is unreadable or not valid JSON`,
        severity: "error",
        subject
      });
    }
    const validVersion = isValidNodeConfig(plan);
    return createObservation({
      key: "network.wiring.node_config",
      message: validVersion
        ? `${plan.networkId} node config at ${plan.physicalPath} parses as ${MOLTNET_NODE_CONFIG_VERSION}`
        : `${plan.networkId} node config at ${plan.physicalPath} does not declare version ${MOLTNET_NODE_CONFIG_VERSION}`,
      severity: validVersion ? "ok" : "error",
      subject
    });
  });

const collectControlUrlObservations = (plans: ReadNodePlan[]): StatusObservation[] => {
  const observations: StatusObservation[] = [];

  for (const plan of plans) {
    if (!isValidNodeConfig(plan)) {
      continue;
    }
    const subject = `network:${plan.networkId}`;

    for (const attachment of plan.parsed?.attachments ?? []) {
      const kind = attachment.runtime?.kind;
      const agentId = typeof attachment.agent?.id === "string" ? attachment.agent.id : "unknown-agent";

      if (kind === "pi") {
        const controlUrl = attachment.runtime?.control_url;
        const valid = typeof controlUrl === "string" && CONTROL_URL_PATTERN.test(controlUrl);
        observations.push(createObservation({
          key: "network.wiring.control_url",
          message: valid
            ? `${agentId} control_url ${String(controlUrl)} matches the expected loopback wake pattern`
            : typeof controlUrl === "string"
              ? `${agentId} control_url "${controlUrl}" does not match the expected loopback wake pattern`
              : `${agentId} pi attachment is missing control_url`,
          severity: valid ? "ok" : "error",
          subject
        }));
      } else if (kind === "picoclaw") {
        const configPath = attachment.runtime?.config_path;
        const valid = typeof configPath === "string" && configPath.length > 0;
        observations.push(createObservation({
          key: "network.wiring.control_url",
          message: valid
            ? `${agentId} picoclaw runtime declares config_path ${String(configPath)}`
            : `${agentId} picoclaw attachment is missing config_path`,
          severity: valid ? "ok" : "error",
          subject
        }));
      }
    }
  }

  return observations;
};

const collectNetworkResolvesObservations = (
  nodePlans: StatusReportMoltnetNodePlan[],
  servers: StatusReportMoltnetServerPlan[]
): StatusObservation[] => {
  const serverNetworkIds = new Set(servers.map((server) => server.networkId));

  return nodePlans.map((plan) => {
    const resolves = serverNetworkIds.has(plan.networkId);
    return createObservation({
      key: "network.wiring.network_resolves",
      message: resolves
        ? `${plan.networkId} node plan resolves to a compiled Moltnet server plan`
        : `${plan.networkId} node plan has no matching compiled Moltnet server plan`,
      severity: resolves ? "ok" : "error",
      subject: `network:${plan.networkId}`
    });
  });
};

const collectAttachmentAgentIdsByNetwork = (plans: ReadNodePlan[]): Map<string, Set<string>> => {
  const idsByNetwork = new Map<string, Set<string>>();
  for (const plan of plans) {
    if (!isValidNodeConfig(plan)) {
      continue;
    }
    const ids = idsByNetwork.get(plan.networkId) ?? new Set<string>();
    for (const attachment of plan.parsed?.attachments ?? []) {
      if (typeof attachment.agent?.id === "string") {
        ids.add(attachment.agent.id);
      }
    }
    idsByNetwork.set(plan.networkId, ids);
  }
  return idsByNetwork;
};

const collectMembershipObservations = (
  servers: StatusReportMoltnetServerPlan[],
  plans: ReadNodePlan[]
): StatusObservation[] => {
  const agentIdsByNetwork = collectAttachmentAgentIdsByNetwork(plans);
  const observations: StatusObservation[] = [];

  for (const server of servers) {
    const knownAgentIds = agentIdsByNetwork.get(server.networkId);
    for (const room of server.rooms) {
      const subject = `room:${server.networkId}:${room.id}`;
      for (const memberId of room.members) {
        const orphan = !knownAgentIds?.has(memberId);
        observations.push(createObservation({
          key: "network.wiring.membership",
          message: orphan
            ? `${server.networkId}/${room.id} member ${memberId} has no matching node config attachment`
            : `${server.networkId}/${room.id} member ${memberId} maps to a node config attachment`,
          severity: orphan ? "warn" : "ok",
          subject
        }));
      }
    }
  }

  return observations;
};

export const collectMoltnetWiringProbeObservations = async (
  options: CollectMoltnetWiringProbeOptions
): Promise<StatusObservation[]> => {
  if (options.loadedReport.kind !== "loaded") {
    return missingReportObservations();
  }

  const { report } = options.loadedReport;
  const servers = report.moltnetServers ?? [];
  const nodePlans = report.moltnetNodePlans ?? [];
  const readPlans = await readNodePlans(nodePlans, options.outputDirectory, options.readFile);

  return [
    ...collectNodeConfigObservations(readPlans),
    ...collectControlUrlObservations(readPlans),
    ...collectNetworkResolvesObservations(nodePlans, servers),
    ...collectMembershipObservations(servers, readPlans)
  ];
};
