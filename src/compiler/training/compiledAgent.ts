import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WORKSPACE_SKILL_BASE_DIRECTORY } from "../../runtime/common.js";

const text = z.string().min(1);
const absolute = text.refine((value) => value.startsWith("/") && value !== "/"
  && path.posix.normalize(value) === value && !/[\\\0]/u.test(value), "Expected a normalized container absolute path");
const agentPaths = z.object({ workspace_path: absolute, home_path: absolute.nullable(), skill_roots: z.array(absolute) });
// Validate the consumed projection, allowing unrelated report fields to evolve.
const reportSchema = z.object({
  spawnfile_version: z.literal("0.1"),
  nodes: z.array(z.object({ id: text, kind: z.enum(["agent", "team"]) })),
  container: z.object({
    runtime_instances: z.array(z.object({ id: text, runtime: text, node_ids: z.array(text), config_path: absolute,
      workspace_path: absolute, home_path: absolute.nullable(), agent_paths: z.record(text, agentPaths).optional() })),
    moltnet: z.object({
      node_plans: z.array(z.object({ node_id: text, member_id: text, network_id: text, config_path: absolute })),
      server_plans: z.array(z.object({ network_id: text, mode: z.enum(["managed", "external"]), config_path: absolute.optional() }))
    }).optional()
  })
});

export interface CompiledAgentPaths {
  workspace: string;
  runtimeConfig: string;
  home: string | null;
  skillRoots: string[];
  moltnet: { networkId: string; memberId: string; nodeConfig: string; serverConfig: string | null }[];
}
export interface CompiledAgent extends CompiledAgentPaths {
  agentId: string;
  runtime: string;
  instanceId: string;
  /** The same paths in the container's namespace; top-level paths address compileOut/container/rootfs. */
  containerPaths: CompiledAgentPaths;
}

/** Read compiler facts only. Does not load runtime state, credentials, or authored manifests. */
export const resolveCompiledAgent = async (compileOut: string, agentName: string): Promise<CompiledAgent> => {
  const file = path.resolve(compileOut, "spawnfile-report.json");
  const report = reportSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const agents = report.nodes.filter((node) => node.kind === "agent");
  const exact = agents.filter((node) => node.id === agentName);
  const candidates = exact.length ? exact : agents.filter((node) => node.id === `agent:${agentName}`);
  if (candidates.length !== 1) throw new Error(`Unknown or ambiguous compiled agent: ${agentName}`);
  const agentId = candidates[0]!.id;
  const instances = report.container.runtime_instances.filter((instance) => instance.node_ids.includes(agentId));
  if (instances.length !== 1) throw new Error(`Expected one compiled runtime instance for ${agentId}`);
  const instance = instances[0]!;
  let paths = instance.agent_paths?.[agentId];
  if (!paths) {
    // Single-agent runtime adapters already report their exact workspace and home.
    if (!["openclaw", "picoclaw"].includes(instance.runtime) || instance.node_ids.length !== 1) {
      throw new Error(`Compile report lacks per-agent paths for ${agentId}; recompile with a current compiler`);
    }
    paths = { workspace_path: instance.workspace_path, home_path: instance.home_path,
      skill_roots: [path.posix.join(instance.workspace_path, path.posix.relative("workspace", WORKSPACE_SKILL_BASE_DIRECTORY))] };
  }
  const moltnet = report.container.moltnet;
  const attachments = (moltnet?.node_plans ?? []).filter((node) => node.node_id === agentId).map((node) => {
    const servers = moltnet!.server_plans.filter((server) => server.network_id === node.network_id);
    if (servers.length !== 1 || (servers[0]!.mode === "managed" && !servers[0]!.config_path)) {
      throw new Error(`Missing or ambiguous Moltnet server plan for ${node.network_id}`);
    }
    return { networkId: node.network_id, memberId: node.member_id, nodeConfig: node.config_path,
      serverConfig: servers[0]!.config_path ?? null };
  });
  const containerPaths: CompiledAgentPaths = { workspace: paths.workspace_path, runtimeConfig: instance.config_path,
    home: paths.home_path, skillRoots: paths.skill_roots, moltnet: attachments };
  const host = (value: string) => path.resolve(compileOut, "container/rootfs", `.${value}`);
  return { agentId, runtime: instance.runtime, instanceId: instance.id, containerPaths,
    workspace: host(containerPaths.workspace), runtimeConfig: host(containerPaths.runtimeConfig),
    home: containerPaths.home === null ? null : host(containerPaths.home), skillRoots: containerPaths.skillRoots.map(host),
    moltnet: attachments.map((entry) => ({ ...entry, nodeConfig: host(entry.nodeConfig),
      serverConfig: entry.serverConfig === null ? null : host(entry.serverConfig) })) };
};
