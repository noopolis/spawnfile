import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileProject } from "./compileProject.js";

vi.mock("./moltnetBinaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./moltnetBinaries.js")>();
  const { stageTrustedTestMoltnetRelease } = await import(
    "../../test/trustedMoltnetRelease.js"
  );
  return {
    ...actual,
    stageMoltnetBinaries: (outputDirectory: string, options: Parameters<
      typeof actual.stageMoltnetBinaries
    >[1]) => stageTrustedTestMoltnetRelease(outputDirectory, options)
  };
});

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const createFakeMoltnetCli = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-evidence-moltnet-"));
  directories.push(root);
  const cliPath = path.join(root, "moltnet");
  await writeFile(cliPath, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'version') process.exit(0);",
    "if (args[0] !== 'skill' || args[1] !== 'install') process.exit(1);",
    "const flags = new Map();",
    "for (let index = 2; index < args.length; index += 2) flags.set(args[index], args[index + 1]);",
    "const target = path.join(flags.get('--workspace'), 'skills', 'moltnet', 'SKILL.md');",
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    "fs.writeFileSync(target, '# Moltnet\\n');"
  ].join("\n") + "\n");
  await chmod(cliPath, 0o755);
  return cliPath;
};

const writeTwoAgentProject = async (): Promise<{ bindingsPath: string; root: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-evidence-org-"));
  directories.push(root);
  await Promise.all(["alpha", "zeta"].map(async (member) => {
    const directory = path.join(root, "agents", member);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "AGENTS.md"), `# ${member}\n`);
    await writeFile(path.join(directory, "Spawnfile"), [
      'spawnfile_version: "0.1"', "kind: agent", `name: ${member}`, "runtime: openclaw", "",
      "surfaces:", "  moltnet:", "    - network: readiness-net", "      rooms:", "        readiness-room:", "          wake: mentions", "      dms:", "        enabled: true", "      auth:", `        token_id: ${member}`, "",
      "workspace:", "  docs:", "    system: AGENTS.md", ""
    ].join("\n"));
  }));
  await writeFile(path.join(root, "TEAM.md"), "# Team\n");
  await writeFile(path.join(root, "Spawnfile"), [
    'spawnfile_version: "0.1"', "kind: team", "name: readiness-team", "mode: swarm", "",
    "members:", "  - id: zeta", "    ref: ./agents/zeta", "  - id: alpha", "    ref: ./agents/alpha", "",
    "external_participants:", "  - id: world", "    kind: service", "    surfaces:", "      moltnet:", "        - network: readiness-net", "          auth:", "            token_id: world", "          dms:", "            enabled: true", "",
    "networks:", "  - id: readiness-net", "    provider: moltnet", "    server:", "      mode: managed", "      listen:", "        bind: 127.0.0.1", "        port: 19123", "      direct_messages: true", "      store:", "        kind: memory", "      auth:", "        mode: bearer", "        client:", "          token_id: operator", "        tokens:", "          - id: operator", "            secret: OPERATOR_TOKEN", "            scopes: [admin, observe, write]", "          - id: alpha", "            secret: ALPHA_TOKEN", "            scopes: [attach, write]", "            agents: [alpha]", "          - id: zeta", "            secret: ZETA_TOKEN", "            scopes: [attach, write]", "            agents: [zeta]", "          - id: world", "            secret: WORLD_TOKEN", "            scopes: [attach, write]", "            agents: [world]", "    rooms:", "      - id: readiness-room", "        members: [zeta, alpha]", ""
  ].join("\n"));
  const bindingsPath = path.join(root, "world-bindings.json");
  await writeFile(bindingsPath, JSON.stringify({
    bindings: ["zeta", "alpha"].map((id) => ({
      capability_manifest_digest: `sha256:${(id === "alpha" ? "a" : "b").repeat(64)}`,
      json: { auth: "bearer", url: "http://world.example/v1/world" },
      mcp: { auth: "bearer", transport: "streamable_http", url: "http://world.example/mcp" },
      member: { id, principal_id: `agent:${id}` }, run_id: "run-evidence", token_env: `WORLD_${id.toUpperCase()}_TOKEN`, world_instance_id: "world-instance"
    })), schema: "simfile.world-bindings.v1"
  }));
  return { bindingsPath, root };
};

describe("compileProject organization readiness evidence", () => {
  it("returns the immutable generic projection without changing its reports", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-evidence-"));
    directories.push(outputDirectory);
    const result = await compileProject(path.resolve("test/fixtures/single-agent"), { outputDirectory });
    expect(result.organizationReadinessEvidence).toBeDefined();
    expect(result.organizationReadinessEvidence?.worldBindings).toBeNull();
    expect(result.organizationReadinessEvidence?.networks).toEqual([]);
    expect(Object.isFrozen(result.organizationReadinessEvidence)).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain("organization-ready-evidence");
  });

  it("derives exact nonempty organization evidence without changing emitted public schemas", async () => {
    const project = await writeTwoAgentProject();
    const outputDirectory = path.join(project.root, ".spawn");
    vi.stubEnv("NOOPOLIS_RUN_ID", "run-evidence");
    vi.stubEnv("SPAWNFILE_MOLTNET_CLI", await createFakeMoltnetCli());
    const result = await compileProject(project.root, { outputDirectory, worldBindingsPath: project.bindingsPath });
    const evidence = result.organizationReadinessEvidence;
    expect(evidence.organizationMembers).toEqual([{ memberId: "alpha", nodeId: expect.any(String) }, { memberId: "zeta", nodeId: expect.any(String) }]);
    expect(evidence.networks).toEqual([expect.objectContaining({
      id: "readiness-net", internalPort: 19123, mode: "managed",
      rooms: [{ id: "readiness-room", members: ["alpha", "zeta"] }],
      nodes: [expect.objectContaining({ configPath: expect.stringMatching(/^\/var\/lib\/spawnfile\/moltnet\/nodes\//u), sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }), expect.anything()]
    })]);
    expect(evidence.worldBindings).toMatchObject({ artifactPath: "/spawnfile/world-bindings.json", schema: "simfile.world-bindings.v1" });
    expect(evidence.worldBindings?.assignments).toEqual(evidence.organizationMembers);
    expect(evidence.worldBindings?.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await Promise.all(evidence.networks[0]!.nodes.map(async (node) => {
      const bytes = await readFile(`${outputDirectory}/container/rootfs${node.configPath}`, "utf8");
      expect(node.sha256).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    }));
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.networks[0]?.nodes)).toBe(true);
    const [compileReport, distributionReport] = await Promise.all([
      readFile(result.reportPath, "utf8"), readFile(path.join(outputDirectory, "distribution-report.json"), "utf8")
    ]);
    expect(compileReport).not.toContain("organization-ready-evidence");
    expect(distributionReport).not.toContain("organization-ready-evidence");
    expect(JSON.parse(distributionReport).world_bindings.digest).toBe(evidence.worldBindings?.digest);
  });
});
