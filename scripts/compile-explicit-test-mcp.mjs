import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((rows, item, index, all) => item.startsWith("--") ? [...rows, [item.slice(2), all[index + 1]]] : rows, []));
if (!args.declaration || !args.report || !args.out) throw new Error("usage: --declaration <file> --report <spawnfile-report.json> --out <directory>");
const declarationBytes = await readFile(path.resolve(args.declaration)); const declaration = JSON.parse(declarationBytes);
const report = JSON.parse(await readFile(path.resolve(args.report), "utf8"));
if (!report || !/^sf1:[a-f0-9]{12}$/u.test(report.compile_fingerprint)) throw new Error("explicit-test MCP lowering requires a compiled Spawnfile report");
const compiledAgents = new Set((report.container?.runtime_instances ?? []).filter((instance) => instance.runtime === "daimon").flatMap((instance) => instance.node_ids ?? []));
exact(declaration, ["version", "servers"]); if (declaration.version !== "spawnfile.explicit-test-mcp-declaration.v1" || !Array.isArray(declaration.servers) || declaration.servers.length > 8) throw new Error("invalid explicit-test MCP declaration");
const servers = declaration.servers.map((value) => { exact(value, ["id", "agent_id", "command", "args", "tools", "env_names"]); if (![value.id, value.agent_id].every(identifier) || !absolute(value.command) || !strings(value.args, 16, absolute) || !strings(value.tools, 16, identifier) || !strings(value.env_names, 16, identifier)) throw new Error("invalid explicit-test MCP server declaration"); return value; }).sort((left, right) => left.id.localeCompare(right.id));
if (servers.some(({ agent_id }) => !compiledAgents.has(agent_id))) throw new Error("explicit-test MCP server agent is absent from compiled Daimon instances");
if (new Set(servers.map(({ id }) => id)).size !== servers.length) throw new Error("duplicate explicit-test MCP server id");
const artifact = { version: "spawnfile.explicit-test-mcp.v1", compile_fingerprint: report.compile_fingerprint, servers };
const artifactBytes = Buffer.from(`${JSON.stringify(artifact)}\n`); const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const receipt = { version: "spawnfile.explicit-test-mcp-receipt.v1", compile_fingerprint: report.compile_fingerprint, declaration_sha256: digest(declarationBytes), artifact_sha256: digest(artifactBytes), servers: servers.map(({ id, agent_id, tools }) => ({ id, agent_id, tools })) };
await mkdir(path.resolve(args.out), { recursive: true }); await writeFile(path.resolve(args.out, "explicit-test-mcp.json"), artifactBytes, { mode: 0o600 }); await writeFile(path.resolve(args.out, "explicit-test-mcp-receipt.json"), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
function exact(value, keys) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("unexpected explicit-test MCP field"); }
function identifier(value) { return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value); }
function absolute(value) { return typeof value === "string" && value.startsWith("/") && value.length <= 1024; }
function strings(value, limit, validator) { return Array.isArray(value) && value.length <= limit && value.every(validator) && new Set(value).size === value.length; }
