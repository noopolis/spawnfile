import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  ensureDirectory,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import { manifestSchema, renderSpawnfile } from "../manifest/index.js";
import { buildCompilePlan } from "./buildCompilePlan.js";
import { generateMoltnetArtifacts } from "./moltnetArtifacts.js";
import { prepareTeamCompileSupport } from "./teamContextSupport.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

const owner = {
  auth: {
    client: { token_id: "operator" },
    mode: "bearer" as const,
    tokens: [
      { id: "operator", secret: "OPERATOR_TOKEN_ENV", scopes: ["admin", "observe", "write"] },
      { agents: ["field.red"], id: "red", secret: "RED_TOKEN_ENV", scopes: ["attach", "write"] },
      { agents: ["world"], id: "world", secret: "WORLD_TOKEN_ENV", scopes: ["attach", "write"] }
    ]
  },
  direct_messages: true,
  listen: { bind: "127.0.0.1", port: 8787 },
  mode: "managed" as const,
  store: { kind: "memory" as const }
};

const childManifest = manifestSchema.parse({
  kind: "team",
  members: [{
    id: "red",
    runtime: "pi",
    surfaces: {
      moltnet: [{
        auth: { token_id: "red" },
        dms: { enabled: true },
        network: "pitch",
        rooms: { field: {} }
      }]
    },
    workspace: { docs: { system: "./red.md" } }
  }],
  mode: "swarm",
  name: "field-team",
  networks: [{
    id: "pitch",
    provider: "moltnet",
    rooms: [{ id: "field", members: ["red"] }]
  }],
  spawnfile_version: "0.1"
});

const rootManifest = manifestSchema.parse({
  external_participants: [{
    id: "world",
    kind: "service",
    surfaces: {
      moltnet: [{
        auth: { token_id: "world" },
        dms: { enabled: true },
        network: "pitch"
      }]
    }
  }],
  kind: "team",
  members: [{ id: "field", ref: "./field" }],
  mode: "swarm",
  name: "tiny-football",
  networks: [{
    id: "pitch",
    name: "Match Pitch",
    provider: "moltnet",
    rooms: [{ id: "field", members: ["field"] }],
    server: owner
  }],
  spawnfile_version: "0.1"
});

const createNestedProject = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-b31-nested-"));
  temporaryDirectories.push(root);
  const child = path.join(root, "field");
  await ensureDirectory(child);
  await Promise.all([
    writeUtf8File(path.join(root, "Spawnfile"), renderSpawnfile(rootManifest)),
    writeUtf8File(path.join(child, "Spawnfile"), renderSpawnfile(childManifest)),
    writeUtf8File(path.join(child, "red.md"), "# Red player\n")
  ]);
  return root;
};

describe("nested B31 Moltnet organization composition", () => {
  it("lowers canonical nested identity through an ownerless child overlay", async () => {
    const childSource = renderSpawnfile(childManifest);
    expect(childSource).not.toMatch(/^\s+server:/mu);
    expect(manifestSchema.parse(YAML.parse(childSource))).toEqual(childManifest);

    const root = await createNestedProject();
    const plan = await buildCompilePlan(root);
    const agent = plan.nodes.find((node) => node.kind === "agent");
    if (!agent || agent.value.kind !== "agent") throw new Error("expected nested agent");

    expect(plan.organizationIdentity?.agentMembers.map((member) => member.memberId))
      .toEqual(["field.red"]);
    expect(plan.moltnetRoomMemberships?.map((membership) => ({
      member: membership.concreteMemberId,
      team: membership.declaringTeamName
    })).sort((left, right) => left.team.localeCompare(right.team))).toEqual([
      { member: "field.red", team: "field-team" },
      { member: "field.red", team: "tiny-football" }
    ]);
    expect(agent.value.surfaces?.moltnet).toEqual([expect.objectContaining({
      auth: { tokenId: "red" },
      dms: { enabled: true },
      memberId: "field.red",
      network: "pitch",
      rooms: { field: {} }
    })]);
    expect(plan.moltnetExternalParticipantIntents?.[0]?.directMessagePeers)
      .toEqual(["field.red"]);

    const artifacts = await generateMoltnetArtifacts(plan);
    if (!artifacts) throw new Error("expected Moltnet artifacts");
    expect(artifacts.serverPlans).toHaveLength(1);
    expect(artifacts.serverPlans[0]?.rooms).toEqual([{
      id: "field",
      members: ["field.red"]
    }]);
    expect(artifacts.nodePlans).toHaveLength(1);
    const nodeFile = artifacts.files.find((file) => file.path.endsWith("-field.red.json"));
    expect(JSON.parse(nodeFile?.content ?? "{}")).toMatchObject({
      attachments: [{ agent: { id: "field.red" } }],
      moltnet: { token_env: "RED_TOKEN_ENV" }
    });
    expect(artifacts.externalParticipantArtifacts?.[0]).toMatchObject({
      direct_messages: [{ members: ["field.red", "world"] }],
      participant: { member_id: "world" }
    });

    const reordered = structuredClone(plan);
    reordered.nodes.reverse();
    const reorderedArtifacts = await generateMoltnetArtifacts(reordered);
    expect(JSON.stringify(reorderedArtifacts)).toBe(JSON.stringify(artifacts));

    const support = await prepareTeamCompileSupport(plan);
    expect([...support.diagnosticsByTeamSource.values()].flat()
      .some((diagnostic) => diagnostic.message.includes("Unable to derive active moltnet context")))
      .toBe(false);
    expect(support.activeEnvironmentsByAgentSource.get(agent.value.source)?.moltnet)
      .toBeDefined();
  });

  it("does not materialize B31 optional fields in an ordinary plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-no-external-"));
    temporaryDirectories.push(root);
    const manifest = manifestSchema.parse({
      kind: "team",
      members: [{
        id: "red",
        runtime: "pi",
        surfaces: { moltnet: [{ network: "pitch", rooms: { field: {} } }] },
        workspace: { docs: { system: "./red.md" } }
      }],
      mode: "swarm",
      name: "ordinary",
      networks: [{
        id: "pitch",
        provider: "moltnet",
        rooms: [{ id: "field", members: ["red"] }],
        server: {
          auth: { mode: "none" },
          listen: { bind: "127.0.0.1", port: 8787 },
          mode: "managed",
          store: { kind: "memory" }
        }
      }],
      spawnfile_version: "0.1"
    });
    await Promise.all([
      writeUtf8File(path.join(root, "Spawnfile"), renderSpawnfile(manifest)),
      writeUtf8File(path.join(root, "red.md"), "# Red\n")
    ]);

    const plan = await buildCompilePlan(root);
    const rootTeam = plan.nodes.find((node) => node.kind === "team")?.value;
    expect(rootTeam && Object.hasOwn(rootTeam, "externalParticipants")).toBe(false);
    expect(plan.organizationIdentity).toMatchObject({
      agentMembers: [{ memberId: "red", principalId: "agent:red" }], externalParticipants: [],
    });
    const artifacts = await generateMoltnetArtifacts(plan);
    expect(artifacts && Object.hasOwn(artifacts, "externalParticipantArtifacts"))
      .toBe(false);
  });
});
