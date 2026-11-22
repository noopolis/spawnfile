import path from "node:path";

export const PROBE_TOKEN_ENV = "SPAWNFILE_DAIMON_CONTROL_TOKEN";
const nativeProbes = ["pi", "daimon"] as const;
const acpProbes = [...nativeProbes, "acp"] as const;
export type MoltnetProbeKind = typeof acpProbes[number];

export const releaseProbeKinds = (includesAcp: boolean): readonly MoltnetProbeKind[] =>
  includesAcp ? acpProbes : nativeProbes;

export const probeReceiptDirectory = (directory: string): string => path.join(directory, "daimon-receipts");

interface ProbeContext {
  hostUrl: string;
  agentId: string;
  receiptPath: string;
  workspace: string;
}

const runtimes = {
  acp: ({ workspace }: ProbeContext) => ({
    kind: "acp", command: "true", args: ["literal argument with spaces"], workspace_path: workspace
  }),
  daimon: ({ hostUrl, receiptPath }: ProbeContext) => ({
    kind: "daimon", control_url: hostUrl, receipt_store_path: receiptPath, token_env: PROBE_TOKEN_ENV
  }),
  pi: ({ hostUrl, agentId }: ProbeContext) => ({
    kind: "pi", control_url: hostUrl + "/agents/" + agentId + "/wake"
  })
};

function probeConfig(kind: MoltnetProbeKind, network: string, name: string, context: ProbeContext) {
  return {
    version: "moltnet.node.v1",
    moltnet: { base_url: "http://127.0.0.1:9", network_id: network },
    attachments: [{ agent: { id: context.agentId, name }, runtime: runtimes[kind](context) }]
  };
}

/** Configuration for the published archive staging check. */
export function createLocalMoltnetBridgeProbeConfig(kind: MoltnetProbeKind, directory: string): string {
  const agentId = kind + "-capability-probe";
  return JSON.stringify(probeConfig(kind, "capability-probe", kind + " capability probe", {
    hostUrl: "http://127.0.0.1:9", agentId, workspace: directory,
    receiptPath: path.join(probeReceiptDirectory(directory), agentId + ".json")
  }));
}

/** Configuration used by the standalone local-release builder. */
export function createCapabilityProbeConfig(kind: MoltnetProbeKind, receiptPath: string) {
  return probeConfig(kind, "capability", kind + " agent", {
    hostUrl: kind === "pi" ? "http://127.0.0.1:19690" : "http://127.0.0.1:19700",
    agentId: kind + "-agent", workspace: path.dirname(receiptPath), receiptPath
  });
}
