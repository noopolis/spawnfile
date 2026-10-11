import { afterEach, expect, it } from "vitest";

import { recordingAgentSchema, type CompileReportWorkspaceGitResource } from "../report/index.js";
import { buildCompilePlan } from "./buildCompilePlan.js";
import { resolveRecordingAgentFacts } from "./recordingAgentFacts.js";
import type { ResolvedAgentNode } from "./types.js";
import { cleanTrainingProjects, network, surfaces, trainingProject } from "./training/plan/fixtures.test-helper.js";

afterEach(cleanTrainingProjects);
const bank = (id: string, root: string) => ({ id, store: { kind: "json", path: `${root}/store.jsonl` } });
const state = (id: string) => ({ id, kind: "volume", mode: "mutable", mount: `./${id}` });
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ spawnfile_version: "0.1", kind: "agent", name, runtime: "daimon", ...extra });

it("projects inherited and local compiled facts without reading feed, bundle, or ledger files", async () => {
  const root = await trainingProject({
    Spawnfile: { spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm", memory: [bank("notes", "/data/team")],
      networks: [network], members: [{ id: "a", ref: "a" }, { id: "b", ref: "b" }],
      shared: { workspace: { resources: [
        { ...state("shared-state"), sharing: "team" },
        { ...state("news-feed"), sharing: "team", name: "news-feed-volume", feed: { directory: "missing-feed" } },
        { id: "archive", kind: "git", url: "https://example.invalid/never-fetched", mode: "readonly", mount: "./archive" },
        { id: "tools", kind: "bundle", source: "missing.tar", sha256: `sha256:${"a".repeat(64)}`, mode: "readonly", mount: "./tools" }
      ] } } },
    "a/Spawnfile": agent("a", { memory: [bank("notes", "/data/private")], surfaces,
      training: { record: { keep: "4h", volumes: ["shared-state", "local-state"] } },
      workspace: { resources: [state("local-state")] } }),
    "b/Spawnfile": agent("b", { surfaces })
  });
  const plan = await buildCompilePlan(root);
  const facts = resolveRecordingAgentFacts(plan);
  expect(facts).toEqual([{
    node_id: "agent:a", slug: "a", directory: "/var/lib/spawnfile/recording/a", keep_ms: 14_400_000,
    networks: ["news"], memory: [
      { id: "notes", declared_by: "agent:a", ledger_path: "/data/private/memory/events.jsonl" },
      { id: "notes", declared_by: "team:news", ledger_path: "/data/team/memory/events.jsonl" }
    ],
    feeds: [{ id: "news-feed", volume_name: "news-feed-volume" }],
    resources: [{ id: "archive", kind: "git" }, { id: "tools", kind: "bundle" }],
    snapshots: ["local-state", "shared-state"]
  }]);
  expect(recordingAgentSchema.safeParse(facts[0]).success).toBe(true);
  expect(JSON.stringify(facts)).not.toContain(root);
  expect(JSON.stringify(facts)).not.toContain("never-fetched");
});

it("retains explicit unknown ledger facts and never invents a path for non-durable memory", async () => {
  const root = await trainingProject({ Spawnfile: agent("writer", { training: { record: {} }, memory: [
    { id: "scratch", store: { kind: "json", path: "/data/scratch/events.jsonl", persistence: { mode: "ephemeral" } } },
    { id: "in-process", store: { kind: "memory" } }
  ] }) });
  expect(resolveRecordingAgentFacts(await buildCompilePlan(root))[0]).toMatchObject({
    memory: [{ id: "in-process", declared_by: "agent:writer", ledger_path: null },
      { id: "scratch", declared_by: "agent:writer", ledger_path: null }], keep_ms: 2_592_000_000
  });
});

it("uses agent-scoped compiled git pins after git resources are lowered to bundles", async () => {
  const bundle = { id: "repo", kind: "bundle", source: "missing.tar", sha256: `sha256:${"b".repeat(64)}`, mode: "readonly", mount: "./repo" };
  const root = await trainingProject({ Spawnfile: { spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm",
    members: [{ id: "a", ref: "a" }, { id: "b", ref: "b" }], shared: { training: { record: {} } } },
    "a/Spawnfile": agent("a", { workspace: { resources: [bundle] } }),
    "b/Spawnfile": agent("b", { workspace: { resources: [bundle] } }) });
  const pins: CompileReportWorkspaceGitResource[] = [{ id: "repo", agent_node_ids: ["agent:a"], declared_by: "agent:a",
    auth: "none", cache_key: "cached", commit: "c".repeat(40), content_bytes: 0, file_count: 0, identity: "dev", platform: "linux/amd64",
    selector: { kind: "default_branch" }, sha256: bundle.sha256, url: "https://example.invalid/private" }];
  const facts = resolveRecordingAgentFacts(await buildCompilePlan(root), pins);
  expect(facts.map(({ node_id, resources }) => ({ node_id, resources }))).toEqual([
    { node_id: "agent:a", resources: [{ id: "repo", kind: "git" }] },
    { node_id: "agent:b", resources: [{ id: "repo", kind: "bundle" }] }
  ]);
  const unowned = pins.map(({ agent_node_ids: _owners, declared_by: _declaring, ...pin }) => pin);
  expect(resolveRecordingAgentFacts(await buildCompilePlan(root), unowned).map(({ resources }) => resources))
    .toEqual([[{ id: "repo", kind: "bundle" }], [{ id: "repo", kind: "bundle" }]]);
});

it("deduplicates repeated visible bank access and rejects a missing declaring node", async () => {
  const root = await trainingProject({ Spawnfile: agent("writer", { training: { record: {} }, memory: [bank("notes", "/data/notes")] }) });
  const plan = await buildCompilePlan(root);
  const node = plan.nodes[0]!.value as ResolvedAgentNode;
  node.memoryAccess = [...node.memoryAccess!, ...node.memoryAccess!];
  expect(resolveRecordingAgentFacts(plan)[0]!.memory).toHaveLength(1);
  node.memoryAccess[0] = { ...node.memoryAccess[0]!, source: "/missing/declaring/Spawnfile" };
  expect(() => resolveRecordingAgentFacts(plan)).toThrow(/no declaring node/u);
});
