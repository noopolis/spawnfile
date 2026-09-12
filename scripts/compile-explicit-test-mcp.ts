import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

type ExplicitTestMcpServer = {
  agent_id: string;
  args: string[];
  command: string;
  env_names: string[];
  id: string;
  tools: string[];
};

type ExplicitTestMcpDeclaration = {
  servers: ExplicitTestMcpServer[];
  version: "spawnfile.explicit-test-mcp-declaration.v1";
};

type CompileReport = {
  compile_fingerprint: string;
  container?: {
    runtime_instances?: RuntimeInstance[];
  };
};

type RuntimeInstance = {
  node_ids?: string[];
  runtime?: string;
};

type RequiredArgs = {
  declaration: string;
  out: string;
  report: string;
};

const digest = (value: Uint8Array): string => (
  `sha256:${createHash("sha256").update(value).digest("hex")}`
);

const parseArgs = (argv: string[]): RequiredArgs => {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item?.startsWith("--") && next !== undefined) {
      args.set(item.slice(2), next);
      index += 1;
    }
  }
  const declaration = args.get("declaration");
  const report = args.get("report");
  const out = args.get("out");
  if (!declaration || !report || !out) {
    throw new Error("usage: --declaration <file> --report <spawnfile-report.json> --out <directory>");
  }
  return { declaration, out, report };
};

const asJsonObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null
);

const exact = (value: unknown, keys: string[]): JsonObject => {
  const object = asJsonObject(value);
  if (!object || Object.keys(object).sort().join() !== [...keys].sort().join()) {
    throw new Error("unexpected explicit-test MCP field");
  }
  return object;
};

const identifier = (value: unknown): value is string => (
  typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value)
);

const absolute = (value: unknown): value is string => (
  typeof value === "string" && value.startsWith("/") && value.length <= 1024
);

const strings = (
  value: unknown,
  limit: number,
  validator: (candidate: unknown) => candidate is string,
): value is string[] => (
  Array.isArray(value)
  && value.length <= limit
  && value.every(validator)
  && new Set(value).size === value.length
);

const parseServer = (value: unknown): ExplicitTestMcpServer => {
  const server = exact(value, ["id", "agent_id", "command", "args", "tools", "env_names"]);
  if (!identifier(server.id)
    || !identifier(server.agent_id)
    || !absolute(server.command)
    || !strings(server.args, 16, absolute)
    || !strings(server.tools, 16, identifier)
    || !strings(server.env_names, 16, identifier)) {
    throw new Error("invalid explicit-test MCP server declaration");
  }
  return {
    agent_id: server.agent_id,
    args: server.args,
    command: server.command,
    env_names: server.env_names,
    id: server.id,
    tools: server.tools,
  };
};

const parseDeclaration = (value: unknown): ExplicitTestMcpDeclaration => {
  const declaration = exact(value, ["version", "servers"]);
  if (declaration.version !== "spawnfile.explicit-test-mcp-declaration.v1"
    || !Array.isArray(declaration.servers)
    || declaration.servers.length > 8) {
    throw new Error("invalid explicit-test MCP declaration");
  }
  return {
    servers: declaration.servers.map(parseServer),
    version: declaration.version,
  };
};

const parseRuntimeInstance = (value: unknown): RuntimeInstance | null => {
  const object = asJsonObject(value);
  if (!object) return null;
  const nodeIds = object.node_ids;
  return {
    node_ids: Array.isArray(nodeIds) && nodeIds.every((nodeId) => typeof nodeId === "string")
      ? nodeIds
      : undefined,
    runtime: typeof object.runtime === "string" ? object.runtime : undefined,
  };
};

const parseCompileReport = (value: unknown): CompileReport => {
  const report = asJsonObject(value);
  if (!report
    || typeof report.compile_fingerprint !== "string"
    || !/^sf1:[a-f0-9]{12}$/u.test(report.compile_fingerprint)) {
    throw new Error("explicit-test MCP lowering requires a compiled Spawnfile report");
  }
  const container = asJsonObject(report.container);
  const runtimeInstances = Array.isArray(container?.runtime_instances)
    ? container.runtime_instances.map(parseRuntimeInstance).filter((instance) => instance !== null)
    : undefined;
  return {
    compile_fingerprint: report.compile_fingerprint,
    container: runtimeInstances ? { runtime_instances: runtimeInstances } : undefined,
  };
};

const args = parseArgs(process.argv.slice(2));
const declarationBytes = await readFile(path.resolve(args.declaration));
const declaration = parseDeclaration(JSON.parse(declarationBytes.toString("utf8")) as unknown);
const report = parseCompileReport(JSON.parse(await readFile(path.resolve(args.report), "utf8")) as unknown);
const compiledAgents = new Set(
  (report.container?.runtime_instances ?? [])
    .filter((instance) => instance.runtime === "daimon")
    .flatMap((instance) => instance.node_ids ?? []),
);
const servers = [...declaration.servers].sort((left, right) => left.id.localeCompare(right.id));
if (servers.some(({ agent_id }) => !compiledAgents.has(agent_id))) {
  throw new Error("explicit-test MCP server agent is absent from compiled Daimon instances");
}
if (new Set(servers.map(({ id }) => id)).size !== servers.length) {
  throw new Error("duplicate explicit-test MCP server id");
}
const artifact = {
  compile_fingerprint: report.compile_fingerprint,
  servers,
  version: "spawnfile.explicit-test-mcp.v1",
};
const artifactBytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
const receipt = {
  artifact_sha256: digest(artifactBytes),
  compile_fingerprint: report.compile_fingerprint,
  declaration_sha256: digest(declarationBytes),
  servers: servers.map(({ id, agent_id, tools }) => ({ agent_id, id, tools })),
  version: "spawnfile.explicit-test-mcp-receipt.v1",
};
await mkdir(path.resolve(args.out), { recursive: true });
await writeFile(path.resolve(args.out, "explicit-test-mcp.json"), artifactBytes, { mode: 0o600 });
await writeFile(
  path.resolve(args.out, "explicit-test-mcp-receipt.json"),
  `${JSON.stringify(receipt)}\n`,
  { mode: 0o600 },
);
