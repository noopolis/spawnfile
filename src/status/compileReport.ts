import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { REPORT_FILENAME } from "../shared/index.js";
import type { StatusInputFailure } from "./types.js";

export interface StatusReportCapability {
  key: string;
  message: string;
  outcome: "degraded" | "supported" | "unsupported";
}

export interface StatusReportDiagnostic {
  level: "error" | "info" | "warn";
  message: string;
}

export interface StatusReportNode {
  capabilities: StatusReportCapability[];
  diagnostics: StatusReportDiagnostic[];
  id: string;
  kind: "agent" | "team";
  outputDir: string | null;
  runtime: string | null;
}

export interface StatusReportRuntimeInstance {
  configPath: string | null;
  homePath: string | null;
  id: string;
  internalPort: number | null;
  nodeIds: string[];
  publishedPort: number | null;
  runtime: string;
  workspacePath: string | null;
}

export interface StatusReportMoltnetRoom {
  id: string;
  members: string[];
  visibility: string | null;
  writePolicy: string | null;
}

export interface StatusReportMoltnetServerPlan {
  authMode: string | null;
  baseUrl: string;
  directMessages: boolean | null;
  id: string;
  mode: "external" | "managed";
  networkId: string;
  operatorTokenSecret: string | null;
  port: number | null;
  publicRead: boolean | null;
  rooms: StatusReportMoltnetRoom[];
  storeKind: string | null;
}

export interface StatusReportContainerPortMapping {
  internalPort: number;
  publishedPort: number;
}

export interface StatusReportPersistentMount {
  id: string;
  mountPath: string;
  reason: string;
  volumeName: string;
}

export interface StatusReportWorkspaceResource {
  backingPath: string;
  id: string;
  kind: string;
  linkPath: string;
  mode: string;
  mount: string;
  sharing: string;
}

export interface StatusReport {
  compileFingerprint: string | null;
  generatedAt: string | null;
  internalPorts?: number[];
  moltnetServers?: StatusReportMoltnetServerPlan[];
  nodes: StatusReportNode[];
  outputDirectory: string | null;
  persistentMounts?: StatusReportPersistentMount[];
  portMappings?: StatusReportContainerPortMapping[];
  publishedPorts?: number[];
  reportPath: string;
  root: string | null;
  runtimeInstances: StatusReportRuntimeInstance[];
  secretsRequired?: string[];
  workspaceResources?: StatusReportWorkspaceResource[];
}

export type LoadedCompileReport =
  | { kind: "failure"; failure: StatusInputFailure; reportPath: string }
  | { kind: "loaded"; report: StatusReport; reportPath: string }
  | { kind: "missing"; reportPath: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toStringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const toNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const toBooleanOrNull = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const toNumberArray = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : [];

const normalizeCapability = (value: unknown): StatusReportCapability | null => {
  if (!isRecord(value)) {
    return null;
  }
  const key = toStringOrNull(value.key);
  const message = toStringOrNull(value.message);
  const outcome = toStringOrNull(value.outcome);
  if (!key || !message || !["degraded", "supported", "unsupported"].includes(outcome ?? "")) {
    return null;
  }
  return { key, message, outcome: outcome as StatusReportCapability["outcome"] };
};

const normalizeDiagnostic = (value: unknown): StatusReportDiagnostic | null => {
  if (!isRecord(value)) {
    return null;
  }
  const level = toStringOrNull(value.level);
  const message = toStringOrNull(value.message);
  if (!message || !["error", "info", "warn"].includes(level ?? "")) {
    return null;
  }
  return { level: level as StatusReportDiagnostic["level"], message };
};

const normalizeNode = (value: unknown): StatusReportNode | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = toStringOrNull(value.id);
  const kind = toStringOrNull(value.kind);
  if (!id || !["agent", "team"].includes(kind ?? "")) {
    return null;
  }
  return {
    capabilities: (Array.isArray(value.capabilities) ? value.capabilities : [])
      .map(normalizeCapability)
      .filter((entry): entry is StatusReportCapability => entry !== null),
    diagnostics: (Array.isArray(value.diagnostics) ? value.diagnostics : [])
      .map(normalizeDiagnostic)
      .filter((entry): entry is StatusReportDiagnostic => entry !== null),
    id,
    kind: kind as StatusReportNode["kind"],
    outputDir: toStringOrNull(value.output_dir),
    runtime: toStringOrNull(value.runtime)
  };
};

const normalizeRuntimeInstance = (value: unknown): StatusReportRuntimeInstance | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = toStringOrNull(value.id);
  const runtime = toStringOrNull(value.runtime);
  if (!id || !runtime) {
    return null;
  }
  return {
    configPath: toStringOrNull(value.config_path),
    homePath: toStringOrNull(value.home_path),
    id,
    internalPort: toNumberOrNull(value.internal_port),
    nodeIds: toStringArray(value.node_ids),
    publishedPort: toNumberOrNull(value.published_port),
    runtime,
    workspacePath: toStringOrNull(value.workspace_path)
  };
};

const normalizeMoltnetRoom = (value: unknown): StatusReportMoltnetRoom | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = toStringOrNull(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    members: toStringArray(value.members),
    visibility: toStringOrNull(value.visibility),
    writePolicy: toStringOrNull(value.write_policy)
  };
};

const normalizeMoltnetServer = (value: unknown): StatusReportMoltnetServerPlan | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = toStringOrNull(value.id);
  const mode = toStringOrNull(value.mode);
  const networkId = toStringOrNull(value.network_id);
  const baseUrl = toStringOrNull(value.base_url);
  if (!id || !baseUrl || !networkId || (mode !== "managed" && mode !== "external")) {
    return null;
  }
  return {
    authMode: toStringOrNull(value.auth_mode),
    baseUrl,
    directMessages: toBooleanOrNull(value.direct_messages),
    id,
    mode,
    networkId,
    operatorTokenSecret: toStringOrNull(value.operator_token_secret),
    port: toNumberOrNull(value.port),
    publicRead: toBooleanOrNull(value.public_read),
    rooms: (Array.isArray(value.rooms) ? value.rooms : [])
      .map(normalizeMoltnetRoom)
      .filter((entry): entry is StatusReportMoltnetRoom => entry !== null),
    storeKind: toStringOrNull(value.store_kind)
  };
};

const normalizePortMapping = (value: unknown): StatusReportContainerPortMapping | null => {
  if (!isRecord(value)) {
    return null;
  }
  const internalPort = toNumberOrNull(value.internal_port);
  const publishedPort = toNumberOrNull(value.published_port);
  return internalPort && publishedPort ? { internalPort, publishedPort } : null;
};

const normalizePersistentMount = (value: unknown): StatusReportPersistentMount | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = toStringOrNull(value.id);
  const mountPath = toStringOrNull(value.mount_path);
  const reason = toStringOrNull(value.reason);
  const volumeName = toStringOrNull(value.volume_name);
  return id && mountPath && reason && volumeName
    ? { id, mountPath, reason, volumeName }
    : null;
};

const normalizeWorkspaceResource = (value: unknown): StatusReportWorkspaceResource | null => {
  if (!isRecord(value)) {
    return null;
  }
  const backingPath = toStringOrNull(value.backing_path);
  const id = toStringOrNull(value.id);
  const kind = toStringOrNull(value.kind);
  const linkPath = toStringOrNull(value.link_path);
  const mode = toStringOrNull(value.mode);
  const mount = toStringOrNull(value.mount);
  const sharing = toStringOrNull(value.sharing);
  return backingPath && id && kind && linkPath && mode && mount && sharing
    ? { backingPath, id, kind, linkPath, mode, mount, sharing }
    : null;
};

const normalizeReport = (
  value: unknown,
  reportPath: string
): StatusReport | null => {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return null;
  }

  const container = isRecord(value.container) ? value.container : {};
  const runtimeInstances = Array.isArray(container.runtime_instances)
    ? container.runtime_instances
    : [];
  const moltnet = isRecord(container.moltnet) ? container.moltnet : {};
  const moltnetServers = Array.isArray(moltnet.server_plans) ? moltnet.server_plans : [];

  return {
    compileFingerprint: toStringOrNull(value.compile_fingerprint),
    generatedAt: toStringOrNull(value.generated_at),
    internalPorts: toNumberArray(container.internal_ports),
    moltnetServers: moltnetServers
      .map(normalizeMoltnetServer)
      .filter((entry): entry is StatusReportMoltnetServerPlan => entry !== null),
    nodes: value.nodes
      .map(normalizeNode)
      .filter((entry): entry is StatusReportNode => entry !== null),
    outputDirectory: toStringOrNull(value.output_directory),
    persistentMounts: (Array.isArray(container.persistent_mounts) ? container.persistent_mounts : [])
      .map(normalizePersistentMount)
      .filter((entry): entry is StatusReportPersistentMount => entry !== null),
    portMappings: (Array.isArray(container.port_mappings) ? container.port_mappings : [])
      .map(normalizePortMapping)
      .filter((entry): entry is StatusReportContainerPortMapping => entry !== null),
    publishedPorts: toNumberArray(container.published_ports ?? container.ports),
    reportPath,
    root: toStringOrNull(value.root),
    runtimeInstances: runtimeInstances
      .map(normalizeRuntimeInstance)
      .filter((entry): entry is StatusReportRuntimeInstance => entry !== null),
    secretsRequired: toStringArray(container.secrets_required),
    workspaceResources: (Array.isArray(container.workspace_resources) ? container.workspace_resources : [])
      .map(normalizeWorkspaceResource)
      .filter((entry): entry is StatusReportWorkspaceResource => entry !== null)
  };
};

export const resolveCompileReportPath = (outputDirectory: string): string =>
  path.join(outputDirectory, REPORT_FILENAME);

export const loadCompileReport = async (
  outputDirectory: string
): Promise<LoadedCompileReport> => {
  const reportPath = resolveCompileReportPath(outputDirectory);
  try {
    await stat(reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", reportPath };
    }
    return {
      failure: { exitCode: 2, message: `Unable to stat compile report ${reportPath}` },
      kind: "failure",
      reportPath
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    return {
      failure: { exitCode: 2, message: `Unable to read compile report ${reportPath}` },
      kind: "failure",
      reportPath
    };
  }

  const report = normalizeReport(parsed, reportPath);
  return report
    ? { kind: "loaded", report, reportPath }
    : {
        failure: { exitCode: 2, message: `Malformed compile report ${reportPath}` },
        kind: "failure",
        reportPath
      };
};
