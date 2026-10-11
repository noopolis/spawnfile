import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createDistributionFingerprint, DISTRIBUTION_REPORT_OUTPUT_FILE, type DistributionReport } from "../distribution/index.js";
import { compileProject } from "./compileProject.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
let root: string, org: string, source: string, commit: string, bundleDigest: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-record-off-baseline-"));
  org = path.join(root, "org");
  source = path.join(root, "source");
  await mkdir(source);
  await git(source, "init", "-q", "-b", "main");
  await writeFile(path.join(source, "source.txt"), "same source\n");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "source");
  commit = (await git(source, "rev-parse", "HEAD")).stdout.trim();
  await run("tar", ["--format=ustar", "-cf", path.join(root, "tools.tar"), "source.txt"], { cwd: source });
  bundleDigest = `sha256:${createHash("sha256").update(await readFile(path.join(root, "tools.tar"))).digest("hex")}`;
  for (const name of ["a", "b"]) {
    await mkdir(path.join(org, name), { recursive: true });
    await writeFile(path.join(org, name, "Spawnfile"), json({
      spawnfile_version: "0.1", kind: "agent", name, runtime: "openclaw",
      execution: { model: { primary: { provider: "anthropic", name: "claude-sonnet-4-5", auth: { method: "claude-code" } } } },
      workspace: { resources: [
        { id: "source", kind: "git", url: `file://${source}`, branch: "main", fetch: "build", mount: "./source", mode: "readonly" },
        { id: "tools", kind: "bundle", source: "../../tools.tar", mount: "./tools", mode: "readonly" }
      ] }
    }));
  }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const compile = async (recording: boolean) => {
  await writeFile(path.join(org, "Spawnfile"), json({ spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm",
    ...(recording ? { shared: { training: { record: {} } } } : {}), members: ["a", "b"].map((id) => ({ id, ref: id })) }));
  return compileProject(org, { bundleCacheDirectory: path.join(root, "cache/workspace-bundles"),
    containerArchitecture: "amd64", outputDirectory: path.join(root, "out") });
};

// Baseline field order is the pre-recording origin/main report contract. Dynamic
// digests and runtime facts are retained, but no new optional field can pass.
const legacyDistribution = (report: DistributionReport): DistributionReport => {
  const body = {
    internal_ports: report.internal_ports, model_auth_methods: report.model_auth_methods,
    moltnet: report.moltnet, organization: report.organization, persistent_mounts: report.persistent_mounts,
    port_mappings: report.port_mappings, ports: report.ports, resources: report.resources,
    runtime_instances: report.runtime_instances, secrets: report.secrets, version: "spawnfile.distribution-report.v1" as const
  };
  return { compile_fingerprint: createDistributionFingerprint(body), generated_at: report.generated_at, ...body };
};

it("recording off preserves pre-change report bytes and deduplication with git and bundle resources", async () => {
  const { report, reportPath, outputDirectory } = await compile(false);
  const pin = report.workspace_git_resources![0]!;
  const baseline = {
    compile_fingerprint: report.compile_fingerprint, container: report.container, diagnostics: report.diagnostics,
    generated_at: report.generated_at, nodes: report.nodes, output_directory: report.output_directory,
    project_name: report.project_name, root: report.root, spawnfile_version: "0.1",
    workspace_bundles: [{ id: "tools", origin: "prebuilt", sha256: bundleDigest }],
    workspace_git_resources: [{
      auth: "none", cache_key: pin.cache_key, commit, content_bytes: "same source\n".length, file_count: 1,
      id: "source", identity: "dev", platform: "linux/amd64", selector: { kind: "branch", value: "main" },
      sha256: pin.sha256, url: `file://${source}`
    }]
  };
  expect(await readFile(reportPath, "utf8")).toBe(json(baseline));
  const distributionBytes = await readFile(path.join(outputDirectory, DISTRIBUTION_REPORT_OUTPUT_FILE), "utf8");
  expect(distributionBytes).toBe(json(legacyDistribution(JSON.parse(distributionBytes))));
});

it("effective recording preserves separate owners for identical git and bundle pins", async () => {
  const { report, outputDirectory } = await compile(true);
  const distribution = JSON.parse(await readFile(path.join(outputDirectory, DISTRIBUTION_REPORT_OUTPUT_FILE), "utf8")) as DistributionReport;
  const agentIds = report.nodes.filter((node) => node.kind === "agent").map((node) => node.id).sort();
  for (const pins of [report.workspace_bundles, report.workspace_git_resources, distribution.workspace_bundles, distribution.workspace_git_resources]) {
    expect(pins).toHaveLength(2);
    expect(pins!.map(({ agent_node_ids, declared_by }) => ({ agent_node_ids, declared_by })))
      .toEqual(agentIds.map((id) => ({ agent_node_ids: [id], declared_by: id })));
    expect(new Set(pins!.map((pin) => pin.sha256)).size).toBe(1);
  }
});
