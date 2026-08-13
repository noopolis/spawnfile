import { describe, expect, it } from "vitest";

import {
  resolveCanonicalAgentMemberId,
  resolveMoltnetExternalParticipantIntents,
  resolveOrganizationIdentity,
  validateB31MoltnetAuth,
} from "./organizationIdentity.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const createPlan = (): CompilePlan => ({
  edges: [{ from: "root", kind: "team_member", label: "member", to: "agent" }],
  nodes: [
    {
      id: "root",
      kind: "team",
      runtimeName: null,
      slug: "root",
      value: {
        description: "",
        external: [],
        externalParticipants: [
          {
            id: "service",
            kind: "service",
            surfaces: {
              moltnet: [
                {
                  auth: { token_id: "service" },
                  dms: { enabled: true },
                  network: "network",
                },
              ],
            },
          },
        ],
        kind: "team",
        lead: null,
        members: [
          {
            id: "member",
            kind: "agent",
            nodeSource: "/project/member.yaml",
            runtimeName: "pi",
          },
        ],
        mode: "swarm",
        name: "organization",
        networks: [
          {
            id: "network",
            name: "network",
            provider: "moltnet",
            rooms: [],
            server: {
              auth: {
                client: { token_id: "operator" },
                mode: "bearer",
                tokens: [
                  {
                    id: "operator",
                    scopes: ["admin", "observe", "write"],
                    secret: "NETWORK_OPERATOR",
                  },
                  {
                    agents: ["member"],
                    id: "member",
                    scopes: ["attach", "write"],
                    secret: "NETWORK_MEMBER",
                  },
                  {
                    agents: ["service"],
                    id: "service",
                    scopes: ["attach", "observe", "write"],
                    secret: "NETWORK_SERVICE",
                  },
                ],
              },
              direct_messages: true,
              listen: { bind: "127.0.0.1", port: 8787 },
              mode: "managed",
              store: { kind: "memory" },
            },
          },
        ],
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile.yaml",
      } as never,
    },
    {
      id: "agent",
      kind: "agent",
      runtimeName: "pi",
      slug: "member",
      value: {
        kind: "agent",
        name: "member",
        source: "/project/member.yaml",
        surfaces: {
          moltnet: [
            {
              auth: { tokenId: "member" },
              dms: { enabled: true },
              memberId: null,
              network: "network",
              teamSource: null,
            },
          ],
        },
      } as never,
    },
  ],
  root: "/project/Spawnfile.yaml",
  runtimes: {},
});

const root = (plan: CompilePlan): ResolvedTeamNode =>
  plan.nodes[0]!.value as ResolvedTeamNode;
const agent = (plan: CompilePlan): ResolvedAgentNode =>
  plan.nodes[1]!.value as ResolvedAgentNode;
const prepare = (plan: CompilePlan): CompilePlan => {
  plan.organizationIdentity = resolveOrganizationIdentity(plan);
  return plan;
};

describe("organization identity defensive branches", () => {
  it("handles absent identity, absent roots, and unknown canonical sources", () => {
    const current = createPlan();
    expect(resolveCanonicalAgentMemberId(current, agent(current).source)).toBeUndefined();
    prepare(current);
    expect(resolveCanonicalAgentMemberId(current, agent(current).source)).toBe("member");
    expect(resolveCanonicalAgentMemberId(current, "/project/unknown.yaml")).toBeUndefined();

    current.root = "/project/missing.yaml";
    root(current).externalParticipants = undefined;
    expect(resolveOrganizationIdentity(current)).toBeUndefined();
  });

  it("rejects duplicate slots, missing children, and mismatched edge declarations", () => {
    const duplicate = createPlan();
    root(duplicate).members.push({
      ...structuredClone(root(duplicate).members[0]!),
      id: "other",
    });
    duplicate.edges.push(structuredClone(duplicate.edges[0]!));
    expect(() => resolveOrganizationIdentity(duplicate)).toThrow(/duplicate organization member slot/u);

    const missing = createPlan();
    missing.edges[0]!.to = "missing";
    expect(() => resolveOrganizationIdentity(missing)).toThrow(/missing node/u);

    const mismatch = createPlan();
    root(mismatch).members[0]!.nodeSource = "/project/other.yaml";
    expect(() => resolveOrganizationIdentity(mismatch)).toThrow(/member edge mismatch/u);
  });

  it("covers unrelated networks and agents without selected surfaces", () => {
    const current = prepare(createPlan());
    root(current).networks!.push({
      id: "unused",
      name: "unused",
      provider: "moltnet",
      rooms: [],
    });
    agent(current).surfaces = undefined;
    expect(() => validateB31MoltnetAuth(current)).toThrow(/not selected by exactly one actor/u);
  });

  it("rejects repeated actor selection and operator-secret reuse", () => {
    const repeated = prepare(createPlan());
    agent(repeated).surfaces!.moltnet!.push(
      structuredClone(agent(repeated).surfaces!.moltnet![0]!),
    );
    expect(() => validateB31MoltnetAuth(repeated)).toThrow(/more than one token/u);

    const reused = prepare(createPlan());
    const server = root(reused).networks![0]!.server;
    if (server?.mode !== "managed") throw new Error("expected managed server");
    server.auth.tokens![1]!.secret = "NETWORK_OPERATOR";
    expect(() => validateB31MoltnetAuth(reused)).toThrow(/duplicate Moltnet token identity/u);
  });

  it("skips external authorities for unmanaged networks", () => {
    const current = prepare(createPlan());
    root(current).networks![0]!.server = {
      auth: { mode: "none" },
      mode: "external",
      url: "https://example.test",
    };
    expect(() => validateB31MoltnetAuth(current)).toThrow(/requires managed/u);

    root(current).networks = [];
    expect(() => validateB31MoltnetAuth(current)).not.toThrow();
  });

  it("rejects missing participant identities and unknown participant networks", () => {
    const missingIdentity = prepare(createPlan());
    missingIdentity.organizationIdentity = {
      ...missingIdentity.organizationIdentity!,
      externalParticipants: [],
    };
    expect(() => resolveMoltnetExternalParticipantIntents(missingIdentity)).toThrow(
      /missing external participant identity/u,
    );

    const unknownNetwork = prepare(createPlan());
    root(unknownNetwork).externalParticipants![0]!.surfaces.moltnet[0]!.network = "unknown";
    expect(() => resolveMoltnetExternalParticipantIntents(unknownNetwork)).toThrow(
      /references unknown network/u,
    );
  });
});
