import type { DeploymentRecord, DockerInspectionResult, DockerProbeExecFile } from "../deployment/index.js";
import { createDockerProbeGateway } from "../deployment/index.js";
import type { RuntimeProbeGateway } from "../runtime/index.js";
import type { LoadedCompileReport, StatusReportMoltnetServerPlan } from "./compileReport.js";
import type { StatusObservation } from "./types.js";

export type StatusNetworkInspections = Map<string, DockerInspectionResult>;

export interface CollectMoltnetProbeOptions {
  authValues?: Record<string, string>;
  deployments: DeploymentRecord[];
  execFile?: DockerProbeExecFile;
  fetchJson?: MoltnetFetchJson;
  inspections: StatusNetworkInspections;
  loadedReport: LoadedCompileReport;
  timeoutMs?: number;
}

export type MoltnetFetchJson = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<MoltnetProbeResponse>;

interface MoltnetProbeResponse {
  error?: string;
  json: unknown;
  ok: boolean;
}

interface MoltnetRoom {
  id: string;
  members: string[];
}

interface MoltnetAgent {
  connected: boolean;
  id: string;
  rooms: string[];
}

interface MoltnetSnapshot {
  agents: MoltnetAgent[];
  directMessages: boolean | null;
  networkId: string | null;
  rooms: MoltnetRoom[];
}

const createObservation = (
  input: Omit<StatusObservation, "label" | "source">
): StatusObservation => ({
  ...input,
  label: `${input.severity.toUpperCase()} ${input.key}`,
  source: "network"
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const parseRooms = (value: unknown): MoltnetRoom[] => {
  const entries = isRecord(value) && Array.isArray(value.rooms) ? value.rooms : [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = toString(entry.id);
    return id ? [{ id, members: toStringArray(entry.members) }] : [];
  });
};

const parseAgents = (value: unknown): MoltnetAgent[] => {
  const entries = isRecord(value) && Array.isArray(value.agents) ? value.agents : [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = toString(entry.id);
    return id
      ? [{ connected: entry.connected === true, id, rooms: toStringArray(entry.rooms) }]
      : [];
  });
};

const parseNetwork = (value: unknown): { directMessages: boolean | null; networkId: string | null } => ({
  directMessages: isRecord(value) && isRecord(value.capabilities) && typeof value.capabilities.direct_messages === "boolean"
    ? value.capabilities.direct_messages
    : null,
  networkId: isRecord(value) ? toString(value.id) : null
});

const defaultFetchJson: MoltnetFetchJson = async (url, headers, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, json: null, ok: false };
    }
    return { json: await response.json(), ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), json: null, ok: false };
  } finally {
    clearTimeout(timer);
  }
};

const authHeadersFor = (
  server: StatusReportMoltnetServerPlan,
  authValues: Record<string, string> = {}
): Record<string, string> | null => {
  if (!server.operatorTokenSecret) {
    return {};
  }
  const token = authValues[server.operatorTokenSecret] ?? process.env[server.operatorTokenSecret];
  return token ? { Authorization: `Bearer ${token}` } : null;
};

const readManagedJson = async (
  gateway: RuntimeProbeGateway,
  server: StatusReportMoltnetServerPlan,
  path: string,
  headers: Record<string, string>
): Promise<MoltnetProbeResponse> => {
  if (!server.port) {
    return { error: "managed Moltnet server has no internal port", json: null, ok: false };
  }
  const response = await gateway.httpGet(server.port, path, headers);
  if (!response.ok) {
    return { error: response.error, json: null, ok: false };
  }
  try {
    return { json: JSON.parse(response.body) as unknown, ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), json: null, ok: false };
  }
};

const readExternalJson = async (
  fetchJson: MoltnetFetchJson,
  server: StatusReportMoltnetServerPlan,
  path: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<MoltnetProbeResponse> =>
  fetchJson(`${server.baseUrl.replace(/\/$/u, "")}${path}`, headers, timeoutMs);

const createManagedGateway = (
  deployments: DeploymentRecord[],
  inspections: StatusNetworkInspections,
  options: CollectMoltnetProbeOptions
): RuntimeProbeGateway | null => {
  for (const deployment of deployments) {
    const inspectionMap = inspections.get(deployment.name);
    const unit = deployment.units[0];
    if (!unit) continue;
    const inspection = inspectionMap?.get(unit.id);
    if (inspection?.running === true) {
      return createDockerProbeGateway(deployment, unit, {
        execFile: options.execFile,
        inspection,
        timeoutMs: options.timeoutMs
      });
    }
  }
  return null;
};

const readSnapshot = async (
  server: StatusReportMoltnetServerPlan,
  options: CollectMoltnetProbeOptions,
  headers: Record<string, string>
): Promise<MoltnetProbeResponse & { snapshot?: MoltnetSnapshot }> => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const gateway = server.mode === "managed"
    ? createManagedGateway(options.deployments, options.inspections, options)
    : null;
  if (server.mode === "managed" && !gateway) {
    return { error: "no running deployment unit hosts the managed Moltnet server", json: null, ok: false };
  }
  const readJson = (path: string): Promise<MoltnetProbeResponse> =>
    gateway
      ? readManagedJson(gateway, server, path, headers)
      : readExternalJson(options.fetchJson ?? defaultFetchJson, server, path, headers, timeoutMs);

  const health = await readJson("/healthz");
  if (!health.ok) return health;
  const network = await readJson("/v1/network");
  if (!network.ok) return network;
  const rooms = await readJson("/v1/rooms");
  if (!rooms.ok) return rooms;
  const agents = await readJson("/v1/agents");
  if (!agents.ok) return agents;

  const parsedNetwork = parseNetwork(network.json);
  return {
    json: null,
    ok: true,
    snapshot: {
      agents: parseAgents(agents.json),
      directMessages: parsedNetwork.directMessages,
      networkId: parsedNetwork.networkId,
      rooms: parseRooms(rooms.json)
    }
  };
};

const compareSnapshot = (
  server: StatusReportMoltnetServerPlan,
  snapshot: MoltnetSnapshot
): StatusObservation[] => {
  const observations: StatusObservation[] = [];
  observations.push(createObservation({
    key: "network.reachable",
    message: `${server.networkId} Moltnet server is reachable`,
    severity: "ok",
    subject: `network:${server.networkId}`
  }));
  if (snapshot.networkId && snapshot.networkId !== server.networkId) {
    observations.push(createObservation({
      key: "network.id",
      message: `expected network ${server.networkId}, live network is ${snapshot.networkId}`,
      severity: "error",
      subject: `network:${server.networkId}`
    }));
  }
  const liveRooms = new Map(snapshot.rooms.map((room) => [room.id, room]));
  const liveAgents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  for (const room of server.rooms) {
    const liveRoom = liveRooms.get(room.id);
    if (!liveRoom) {
      observations.push(createObservation({
        key: "network.room",
        message: `${server.networkId}/${room.id} is missing from live Moltnet`,
        severity: "error",
        subject: `room:${server.networkId}:${room.id}`
      }));
      continue;
    }
    observations.push(createObservation({
      key: "network.room",
      message: `${server.networkId}/${room.id} exists with ${liveRoom.members.length} member(s)`,
      severity: "ok",
      subject: `room:${server.networkId}:${room.id}`
    }));
    for (const member of room.members) {
      const liveAgent = liveAgents.get(member);
      if (!liveAgent) {
        observations.push(createObservation({
          key: "network.member",
          message: `${member} is expected in ${room.id} but is not registered`,
          severity: "warn",
          subject: `agent:${member}`
        }));
      } else if (!liveAgent.rooms.includes(room.id)) {
        observations.push(createObservation({
          key: "network.member",
          message: `${member} is registered but not attached to ${room.id}`,
          severity: "warn",
          subject: `agent:${member}`
        }));
      } else if (!liveAgent.connected) {
        observations.push(createObservation({
          key: "network.agent.connected",
          message: `${member} is attached to ${room.id} but disconnected`,
          severity: "warn",
          subject: `agent:${member}`
        }));
      } else {
        observations.push(createObservation({
          key: "network.agent.connected",
          message: `${member} is connected to ${room.id}`,
          severity: "ok",
          subject: `agent:${member}`
        }));
      }
    }
  }
  if (snapshot.directMessages !== null && server.directMessages !== null && snapshot.directMessages !== server.directMessages) {
    observations.push(createObservation({
      key: "network.direct_messages",
      message: `direct messages expected ${server.directMessages}, live value is ${snapshot.directMessages}`,
      severity: "warn",
      subject: `network:${server.networkId}`
    }));
  }
  return observations;
};

export const collectMoltnetProbeObservations = async (
  options: CollectMoltnetProbeOptions
): Promise<StatusObservation[]> => {
  if (options.loadedReport.kind !== "loaded") {
    return [];
  }

  const observations: StatusObservation[] = [];
  for (const server of options.loadedReport.report.moltnetServers ?? []) {
    const headers = authHeadersFor(server, options.authValues);
    if (headers === null) {
      observations.push(createObservation({
        key: "network.auth",
        message: `${server.networkId} requires operator token ${server.operatorTokenSecret}, but no value is available`,
        severity: "unknown",
        subject: `network:${server.networkId}`
      }));
      continue;
    }

    const response = await readSnapshot(server, options, headers);
    if (!response.ok || !response.snapshot) {
      observations.push(createObservation({
        key: "network.reachable",
        message: `${server.networkId} Moltnet metadata probe failed: ${response.error ?? "unknown failure"}`,
        severity: "unknown",
        subject: `network:${server.networkId}`
      }));
      continue;
    }
    observations.push(...compareSnapshot(server, response.snapshot));
  }
  return observations;
};
