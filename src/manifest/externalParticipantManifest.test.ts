import { describe, expect, it } from "vitest";

import { manifestSchema } from "./schemas.js";

const createManagedServer = (auth: Record<string, unknown>): Record<string, unknown> => ({
  auth,
  direct_messages: true,
  listen: { bind: "127.0.0.1", port: 8787 },
  mode: "managed",
  store: { kind: "memory" }
});

const createTeam = (
  externalNetwork?: string,
  token: Record<string, unknown> = {
    id: "operator",
    secret: "OPERATOR",
    scopes: ["admin", "observe", "write"]
  }
): Record<string, unknown> => ({
  kind: "team",
  members: [{ id: "worker", ref: "./agents/worker" }],
  mode: "swarm",
  name: "worker-cell",
  networks: [{
    id: "team-net",
    provider: "moltnet",
    rooms: [{ id: "workroom", members: ["worker"] }],
    server: createManagedServer({
      client: { token_id: "operator" },
      mode: "bearer",
      tokens: [token]
    })
  }],
  spawnfile_version: "0.1",
  ...(externalNetwork === undefined ? {} : {
    external_participants: [{
      id: "world",
      kind: "service",
      surfaces: {
        moltnet: [{
          auth: { token_id: "world" },
          dms: { enabled: true },
          network: externalNetwork
        }]
      }
    }]
  })
});

describe("external participant manifest", () => {
  it("admits the exact topology operator only with a same-network external attachment", () => {
    expect(manifestSchema.safeParse(createTeam("team-net")).success).toBe(true);
    expect(manifestSchema.safeParse(createTeam()).success).toBe(false);
    expect(manifestSchema.safeParse(createTeam("other-net")).success).toBe(false);
  });

  it("admits a same-network external service as a private room member", () => {
    const manifest = createTeam("team-net");
    const network = (manifest.networks as Array<Record<string, unknown>>)[0]!;
    const room = (network.rooms as Array<Record<string, unknown>>)[0]!;
    room.members = ["worker", "world"];
    expect(manifestSchema.safeParse(manifest).success).toBe(true);

    room.members = ["worker", "unattached-service"];
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("preserves ordinary clients and rejects topology-operator near misses", () => {
    const legacy = createTeam();
    (legacy.networks as Array<Record<string, unknown>>)[0].server = createManagedServer({
      client: { token_id: "agent" },
      mode: "bearer",
      tokens: [{ id: "agent", secret: "AGENT", scopes: ["attach", "write"] }]
    });
    expect(manifestSchema.safeParse(legacy).success).toBe(true);
    for (const token of [
      { id: "operator", secret: "OPERATOR", scopes: ["observe", "admin", "write"] },
      { id: "operator", secret: "OPERATOR", agents: [], scopes: ["admin", "observe", "write"] },
      { id: "operator", secret: "OPERATOR", scopes: ["admin", "observe", "write", "attach"] },
      { id: "alternate", secret: "OPERATOR", scopes: ["admin", "observe", "write"] }
    ]) {
      expect.soft(manifestSchema.safeParse(createTeam("team-net", token)).success).toBe(false);
    }
  });

  it("rejects unknown fields, duplicate attachments, and external-participant overflow", () => {
    const unknown = createTeam("team-net");
    (unknown.external_participants as Array<Record<string, unknown>>)[0].unknown = true;
    expect.soft(manifestSchema.safeParse(unknown).success, "unknown key").toBe(false);

    const duplicate = createTeam("team-net");
    const participant = (duplicate.external_participants as Array<Record<string, unknown>>)[0];
    const surfaces = participant.surfaces as { moltnet: unknown[] };
    surfaces.moltnet.push(structuredClone(surfaces.moltnet[0]));
    expect.soft(manifestSchema.safeParse(duplicate).success, "duplicate network").toBe(false);

    const overflow = createTeam("team-net");
    const prototype = (overflow.external_participants as unknown[])[0];
    overflow.external_participants = Array.from({ length: 33 }, (_, index) => ({
      ...(structuredClone(prototype) as object),
      id: `world-${index}`
    }));
    expect.soft(manifestSchema.safeParse(overflow).success, "participant bound").toBe(false);
  });
});
