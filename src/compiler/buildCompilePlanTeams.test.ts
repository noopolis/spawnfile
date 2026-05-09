import { describe, expect, it } from "vitest";

import type { TeamManifest } from "../manifest/index.js";

import {
  resolveTeamExternalIds,
  resolveTeamNetworks,
  validateTeamNetworkRooms
} from "./buildCompilePlanTeams.js";
import type { ResolvedTeamNode } from "./types.js";

const createTeamManifest = (
  overrides: Partial<TeamManifest> = {}
): TeamManifest => ({
  kind: "team",
  members: [
    { id: "lead", ref: "./agents/lead" },
    { id: "reviewer", ref: "./agents/reviewer" }
  ],
  mode: "swarm",
  name: "team",
  spawnfile_version: "0.1",
  ...overrides
});

const createResolvedTeam = (
  overrides: Partial<ResolvedTeamNode> = {}
): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  kind: "team",
  lead: null,
  members: [
    {
      id: "lead",
      kind: "agent",
      nodeSource: "/tmp/lead/Spawnfile",
      runtimeName: "openclaw"
    }
  ],
  mode: "swarm",
  name: "team",
  networks: [],
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: "/tmp/team/Spawnfile",
  ...overrides
});

describe("buildCompilePlanTeams", () => {
  it("resolves external ids from explicit, hierarchical, and swarm teams", () => {
    expect(resolveTeamExternalIds(createTeamManifest({
      external: ["reviewer"]
    }))).toEqual(["reviewer"]);
    expect(resolveTeamExternalIds(createTeamManifest({
      lead: "lead",
      mode: "hierarchical"
    }))).toEqual(["lead"]);
    expect(resolveTeamExternalIds(createTeamManifest())).toEqual(["lead", "reviewer"]);
  });

  it("rejects invalid lead and external member references", () => {
    expect(() => resolveTeamExternalIds(createTeamManifest({
      lead: "missing",
      mode: "hierarchical"
    }))).toThrow(/lead references unknown member missing/);
    expect(() => resolveTeamExternalIds(createTeamManifest({
      external: ["missing"]
    }))).toThrow(/external representative references unknown member missing/);
  });

  it("resolves networks with default names, room names, and server blocks", () => {
    const networks = resolveTeamNetworks(createTeamManifest({
      networks: [
        {
          id: "org",
          provider: "moltnet",
          rooms: [
            {
              id: "general",
              members: ["lead"],
              name: "General"
            }
          ],
          server: {
            auth: { mode: "none" },
            listen: { bind: "127.0.0.1", port: 8787 },
            mode: "managed",
            store: { kind: "memory" }
          }
        }
      ]
    }));

    expect(networks).toEqual([
      {
        id: "org",
        name: "org",
        provider: "moltnet",
        rooms: [{ id: "general", members: ["lead"], name: "General" }],
        server: {
          auth: { mode: "none" },
          listen: { bind: "127.0.0.1", port: 8787 },
          mode: "managed",
          store: { kind: "memory" }
        }
      }
    ]);
  });

  it("rejects network rooms that reference missing resolved members", () => {
    expect(() => validateTeamNetworkRooms(createResolvedTeam({
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "general", members: ["missing"] }]
        }
      ]
    }))).toThrow(/Moltnet room general references unknown member missing/);
  });
});
