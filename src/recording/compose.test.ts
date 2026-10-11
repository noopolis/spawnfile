import { describe, expect, it } from "vitest";

import type { DeployResources } from "../deployment/index.js";
import type { RecordingAgentReport } from "../report/index.js";
import type { FeedLanding } from "../volume/index.js";
import { composeMomentRecord } from "./compose.js";
import { WAKE_MOMENT_VERSION, type ComposeMomentRecordInput } from "./types.js";

const startedAt = "2026-10-09T08:20:31.250Z";
const before = "2026-10-09T08:00:00.000Z";
const after = "2026-10-09T09:00:00.000Z";
const deploymentRecordPath = "/test/output/deployments/dev.json";
const sha256 = `sha256:${"a".repeat(64)}`;
const revision = "b".repeat(64);
const commit = "c".repeat(40);

const facts = (): RecordingAgentReport => ({
  node_id: "agent:writer", slug: "writer", directory: "/var/lib/spawnfile/recording/writer", keep_ms: 86_400_000,
  networks: ["news", "desk"], memory: [{ id: "self", declared_by: "agent:writer", ledger_path: "/memory/writer/events.jsonl" }],
  feeds: [{ id: "news", volume_name: "shared-news" }],
  resources: [{ id: "tools", kind: "bundle" }, { id: "archive", kind: "git" }], snapshots: ["edition-state"]
});
const historicalAgent = (value: ComposeMomentRecordInput): RecordingAgentReport => value.deployResources[0]!.recording_agents![0]!;

const deployment = (overrides: Partial<DeployResources> = {}): DeployResources => ({
  version: "spawnfile.deploy-resources.v1", deployment: "dev", deployment_id: deploymentRecordPath,
  activated_at: before, activation_exact: true, deployed_at: after, report_sha256: sha256,
  recording_agents: [facts()], resources: [
    { id: "archive", kind: "git", agent_node_ids: ["agent:writer"], commit, sha256, url: "private git remote" },
    { id: "tools", kind: "bundle", agent_node_ids: ["agent:writer"], sha256, origin: "private bundle path" }
  ], ...overrides
});
const landing = (overrides: Partial<FeedLanding> = {}): FeedLanding => ({
  version: "spawnfile.volume-feed-landing.v1", resource: "news", volume: "shared-news",
  revision, tree: `trees/${revision}.1`, source: { kind: "git", repo: "private feed remote" },
  commit, ref: "data/2026-10-09", paths: ["published"], switching_at: before, landed_at: before, period: "2026-10-09", ...overrides
});
const input = (): ComposeMomentRecordInput => ({
  row: {
    version: WAKE_MOMENT_VERSION, agent_id: "agent:writer", execution_id: "execution-17", started_at: startedAt,
    deliveries: [
      { acceptance_id: "accepted-1", delivery_id: "schedule:edition", kind: "schedule", occurred_at: before },
      { acceptance_id: "accepted-2", delivery_id: "moltnet:42", kind: "message", occurred_at: "2026-10-09T08:20:31.000Z" },
      { acceptance_id: "accepted-3", delivery_id: "moltnet:43", kind: "message", occurred_at: startedAt }
    ],
    snapshots: [{ id: "edition-state", snapshot: "20261009T082031250Z-execution-17", files: 2, copied: 1, linked: 1, skipped: 0 }]
  },
  agentNodeId: "agent:writer",
  deploymentRecordPath, feedLandings: { news: [landing()] }, deployResources: [deployment()],
  memoryLedgers: { "/memory/writer/events.jsonl": { entries: [
    { seq: 1, createdAt: before }, { seq: 2, createdAt: startedAt }, { seq: 3, createdAt: after }
  ] } }, recordedAt: after
});

describe("composeMomentRecord", () => {
  it.each(["constructor", "__proto__"])("reports missing history for the literal resource id %s", (id) => {
    const value = input();
    historicalAgent(value).feeds = [{ id, volume_name: "shared-news" }];
    value.feedLandings = {};
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, feeds: [], errors: [expect.stringContaining(id)] });
  });

  it("composes all supplied pins at the turn instant without leaking source metadata", () => {
    expect(composeMomentRecord(input())).toEqual({
      version: "spawnfile.moment-record.v1", agent: "agent:writer", exact: true, recordedAt: after,
      wake: { at: before, startedAt, executionId: "execution-17", surface: "moltnet", messageId: "42",
        deliveries: [
          { deliveryId: "schedule:edition", kind: "schedule", occurredAt: before },
          { deliveryId: "moltnet:42", kind: "message", occurredAt: "2026-10-09T08:20:31.000Z" },
          { deliveryId: "moltnet:43", kind: "message", occurredAt: startedAt }
        ] },
      resources: [{ id: "archive", kind: "git", commit, sha256 }, { id: "tools", kind: "bundle", sha256 }],
      feeds: [{ id: "news", revision, tree: `trees/${revision}.1`, commit, ref: "data/2026-10-09", paths: ["published"], landedAt: before, period: "2026-10-09" }],
      memory: [{ id: "self", declaredBy: "agent:writer", seq: 2 }],
      moltnet: [{ network: "desk", cursor: startedAt, messageIds: ["42", "43"] }, { network: "news", cursor: startedAt, messageIds: ["42", "43"] }],
      volumes: [{ id: "edition-state", snapshot: "20261009T082031250Z-execution-17" }]
    });
  });

  it("selects the highest sequence inclusively even with unsorted ledger entries and offset timestamps", () => {
    const value = input();
    value.memoryLedgers = { "/memory/writer/events.jsonl": { entries: [
      { seq: 5, createdAt: "2026-10-09T10:20:31.250+02:00" },
      { seq: 7, createdAt: "2026-10-09T08:20:31.251Z" },
      { seq: 4, createdAt: before }, { seq: 6, createdAt: before }
    ] } };
    expect(composeMomentRecord(value).memory[0]!.seq).toBe(6);
    value.memoryLedgers = { "/memory/writer/events.jsonl": { entries: [
      { seq: 4, createdAt: before }, { seq: 5, createdAt: "2026-10-09T10:20:31.250+02:00" }
    ] } };
    expect(composeMomentRecord(value).memory[0]!.seq).toBe(5);
  });

  it.each([{ entries: [] }, { entries: [{ seq: 1, createdAt: after }] }])("uses seq 0 only when a readable ledger has no event at the boundary: %j", ({ entries }) => {
    const value = input();
    value.memoryLedgers = { "/memory/writer/events.jsonl": { entries } };
    expect(composeMomentRecord(value)).toMatchObject({ exact: true, memory: [{ seq: 0 }] });
  });

  it("keeps equal bank ids separate by their declaring node and physical ledger", () => {
    const value = input();
    historicalAgent(value).memory = [
      ...historicalAgent(value).memory, { id: "self", declared_by: "team:desk", ledger_path: "/memory/desk/events.jsonl" }
    ];
    value.memoryLedgers = { ...value.memoryLedgers, "/memory/desk/events.jsonl": { entries: [{ seq: 7, createdAt: before }] } };
    expect(composeMomentRecord(value).memory).toEqual([
      { id: "self", declaredBy: "agent:writer", seq: 2 }, { id: "self", declaredBy: "team:desk", seq: 7 }
    ]);
  });

  it("uses activation time and agent ownership when resource ids recur across agents", () => {
    const value = input();
    const current = deployment({ activated_at: startedAt, resources: [
      { id: "archive", kind: "git", agent_node_ids: ["agent:other"], commit: "d".repeat(40), sha256 },
      ...deployment().resources
    ] });
    value.deployResources = [deployment({ resources: [] }), current, deployment({ activated_at: after, resources: [] })];
    expect(composeMomentRecord(value)).toMatchObject({ exact: true, resources: [{ id: "archive", commit }, { id: "tools" }] });
    value.row.started_at = "2026-10-09T08:20:31.249Z";
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, resources: [] });
  });

  it("does not borrow resource history from another deployment identity or another agent", () => {
    const value = input();
    value.deployResources = [deployment({ deployment_id: "/elsewhere/output/deployments/dev.json" }), deployment({
      resources: deployment().resources.map((resource) => ({ ...resource, agent_node_ids: ["agent:other"] }))
    })];
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, resources: [], errors: [
      expect.stringContaining("Missing deployment history for git resource archive"),
      expect.stringContaining("Missing deployment history for bundle resource tools")
    ] });
  });

  it("does not fall back to an older deployment when the active one lacks a consumed resource", () => {
    const value = input();
    value.deployResources = [deployment(), deployment({ activated_at: startedAt, resources: [] })];
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, resources: [] });
  });

  it("refuses ambiguous same-agent pins and honors a non-exact activation marker", () => {
    const value = input();
    value.deployResources = [deployment({ activation_exact: false, activation_note: "overlapping predecessor",
      resources: [...deployment().resources, deployment().resources[0]!] })];
    const moment = composeMomentRecord(value);
    expect(moment.exact).toBe(false);
    expect(moment.errors).toEqual([
      "Deployment activation is non-exact: overlapping predecessor",
      expect.stringContaining("Ambiguous deployment history for git resource archive")
    ]);
    expect(moment.resources).toEqual([{ id: "tools", kind: "bundle", sha256 }]);
  });

  it("selects feed history inclusively, resolves ties by append order and never advances to recordedAt", () => {
    const value = input();
    value.feedLandings = { news: [landing(), landing({ switching_at: startedAt, landed_at: startedAt, tree: `trees/${revision}.2` }),
      landing({ switching_at: startedAt, landed_at: "2026-10-09T10:20:31.250+02:00", tree: `trees/${revision}.3` }),
      landing({ switching_at: after, landed_at: after, tree: `trees/${revision}.4` })] };
    expect(composeMomentRecord(value).feeds[0]!.tree).toBe(`trees/${revision}.3`);
  });

  it.each([{ entries: [] }, { entries: [landing({ switching_at: after, landed_at: after })] }, { entries: [landing({ resource: "foreign" })] }])("marks unavailable feed history non-exact: %j", ({ entries }) => {
    const value = input();
    value.feedLandings = { news: entries };
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, feeds: [], errors: [expect.stringContaining("Missing feed history for news")] });
  });

  it("omits optional fields for directory feeds", () => {
    const value = input();
    const { commit: _commit, ref: _ref, paths: _paths, period: _period, ...directoryLanding } = landing();
    directoryLanding.source = { kind: "directory", directory: "/feed" };
    value.feedLandings = { news: [directoryLanding] };
    expect(composeMomentRecord(value).feeds).toEqual([{ id: "news", revision, tree: `trees/${revision}.1`, landedAt: before }]);
  });

  it("accumulates row, missing snapshot and invalid input errors beside known pins", () => {
    const value = input();
    value.errors = ["feed news line 8 invalid", "deployment log line 3 invalid"];
    value.row.error = "cache: root_missing";
    historicalAgent(value).snapshots = ["edition-state", "cache"];
    expect(composeMomentRecord(value)).toMatchObject({ exact: false,
      errors: ["feed news line 8 invalid", "deployment log line 3 invalid", "Wake recording: cache: root_missing", "Missing pre-turn snapshot for cache"],
      volumes: [{ id: "edition-state", snapshot: "20261009T082031250Z-execution-17" }]
    });
  });

  it.each([undefined, { entries: [], errors: ["permission denied"] }, { entries: [{ seq: 1, createdAt: before }], errors: ["line 2 invalid"] }])("does not label an unknown memory history as empty: %j", (ledger) => {
    const value = input();
    value.memoryLedgers = ledger ? { "/memory/writer/events.jsonl": ledger } : {};
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, memory: [], errors: [expect.stringContaining("Memory bank self (agent:writer)")] });
  });

  it("marks a bank without a file-backed ledger non-exact", () => {
    const value = input();
    historicalAgent(value).memory = [{ id: "remote", declared_by: "team:desk", ledger_path: null }];
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, memory: [], errors: ["Memory bank remote (team:desk): ledger could not be read"] });
  });

  it("never invents Moltnet metadata for other deliveries or empty message ids", () => {
    const value = input();
    value.row.deliveries = [value.row.deliveries[0]!, { acceptance_id: "accepted-2", delivery_id: "moltnet:", kind: "message", occurred_at: before }];
    const moment = composeMomentRecord(value);
    expect(moment.wake).not.toHaveProperty("surface");
    expect(moment.wake).not.toHaveProperty("messageId");
    expect(moment.wake).not.toHaveProperty("room");
    expect(moment.wake).not.toHaveProperty("from");
    expect(moment.moltnet).toEqual([{ network: "desk", cursor: startedAt }, { network: "news", cursor: startedAt }]);
  });

  it("uses the first delivery's occurrence time, preserves order and includes all wake message ids", () => {
    const value = input();
    value.row.deliveries[0]!.occurred_at = startedAt;
    value.row.deliveries.push({ ...value.row.deliveries[1]!, delivery_id: "moltnet:id:with:colons" });
    historicalAgent(value).networks = ["news", "news"];
    const moment = composeMomentRecord(value);
    expect(moment.wake.at).toBe(startedAt);
    expect(moment.wake).not.toHaveProperty("room");
    expect(moment.wake).not.toHaveProperty("from");
    expect(moment.moltnet).toEqual([{ network: "news", cursor: startedAt, messageIds: ["42", "43", "id:with:colons"] }]);
  });

  it("marks a row from another compiled agent non-exact", () => {
    const value = input();
    value.row.agent_id = "writer";
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, errors: ["Wake agent writer does not match compiled agent agent:writer"] });
  });

  it("does not require absent optional histories, mutate inputs or consult a clock", () => {
    const value = input();
    value.deployResources = [deployment({ recording_agents: [{ ...facts(), networks: [], memory: [], feeds: [], resources: [], snapshots: [] }] })];
    value.row.snapshots = [];
    const original = JSON.stringify(value);
    const first = composeMomentRecord(value), second = composeMomentRecord(value);
    expect(first).toEqual(second);
    expect(first.exact).toBe(true);
    expect(JSON.stringify(value)).toBe(original);
    expect(first.memory).toEqual([]);
  });

  it.each([before, startedAt, after])("marks an inclusive feed transition at %s non-exact", (instant) => {
    const value = input();
    value.row.started_at = instant;
    value.feedLandings = { news: [landing({ switching_at: before, landed_at: after })] };
    expect(composeMomentRecord(value)).toMatchObject({ exact: false,
      errors: [expect.stringContaining("Feed news transition is ambiguous")], feeds: [{ id: "news" }] });
    value.row.started_at = "2026-10-09T09:00:00.001Z";
    expect(composeMomentRecord(value).exact).toBe(true);
  });

  it.each([before, startedAt, after])("honors a rolled-back candidate interval at %s", (instant) => {
    const value = input();
    const predecessor = deployment({ activated_at: "2026-10-09T07:00:00Z" });
    value.feedLandings = { news: [landing({ switching_at: "2026-10-09T07:00:00Z", landed_at: "2026-10-09T07:00:00Z" })] };
    value.deployResources = [predecessor, deployment({ activated_at: before, rolled_back_at: after,
      exact: false, activation_exact: false, activation_note: "Candidate ran before rollback" })];
    value.row.started_at = instant;
    expect(composeMomentRecord(value)).toMatchObject({ exact: false,
      errors: [expect.stringContaining("Candidate ran before rollback")] });
    value.row.started_at = "2026-10-09T09:00:00.001Z";
    expect(composeMomentRecord(value).exact).toBe(true);
  });

  it.each([{ entries: [] }, { entries: [deployment({ recording_agents: undefined })] }, { entries: [deployment({ recording_agents: [] })] },
    { entries: [deployment({ activated_at: after })] }])("requires activation facts even when no pins are configured: %#", ({ entries }) => {
    const value = input();
    value.deployResources = entries;
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, resources: [], feeds: [], memory: [], moltnet: [],
      errors: [expect.stringContaining("Missing")] });
  });

  it("uses old facts after a release removes resources, feeds, snapshots, networks and changes memory paths", () => {
    const value = input();
    const nextFacts = { ...facts(), resources: [], feeds: [], snapshots: [], networks: [],
      memory: [{ id: "self", declared_by: "team:new", ledger_path: "/memory/new/events.jsonl" }] };
    value.deployResources = [deployment(), deployment({ activated_at: after, resources: [], recording_agents: [nextFacts] })];
    value.memoryLedgers = { ...value.memoryLedgers, "/memory/new/events.jsonl": { entries: [{ seq: 99, createdAt: before }] } };
    const old = composeMomentRecord(value);
    expect(old).toMatchObject({ exact: true, resources: [{ id: "archive", commit }, { id: "tools" }],
      memory: [{ id: "self", declaredBy: "agent:writer", seq: 2 }], feeds: [{ id: "news" }],
      moltnet: [{ network: "desk" }, { network: "news" }] });
    value.row.snapshots = [];
    expect(composeMomentRecord(value)).toMatchObject({ exact: false, errors: ["Missing pre-turn snapshot for edition-state"] });
    value.row.started_at = after;
    expect(composeMomentRecord(value)).toMatchObject({ exact: true, resources: [], feeds: [], moltnet: [],
      memory: [{ id: "self", declaredBy: "team:new", seq: 99 }] });
  });
});
