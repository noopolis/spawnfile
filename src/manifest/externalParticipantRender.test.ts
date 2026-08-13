import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { renderSpawnfile } from "./renderSpawnfile.js";
import { manifestSchema } from "./schemas.js";

const manifest = manifestSchema.parse({
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
  members: [{ id: "red", ref: "./agents/red" }],
  mode: "swarm",
  name: "tiny-football",
  networks: [{
    id: "pitch",
    provider: "moltnet",
    rooms: [{ id: "field", members: ["red"] }],
    server: {
      auth: {
        client: { token_id: "operator" },
        mode: "bearer",
        tokens: [
          { id: "operator", secret: "OPERATOR_TOKEN_ENV", scopes: ["admin", "observe", "write"] },
          { agents: ["red"], id: "red", secret: "RED_TOKEN_ENV", scopes: ["attach", "write"] },
          { agents: ["world"], id: "world", secret: "WORLD_TOKEN_ENV", scopes: ["attach", "write"] }
        ]
      },
      direct_messages: true,
      listen: { bind: "127.0.0.1", port: 8787 },
      mode: "managed",
      store: { kind: "memory" }
    }
  }],
  spawnfile_version: "0.1"
});

describe("external participant canonical rendering", () => {
  it("round-trips secret env identities without reading credential values", () => {
    const canary = "actual-operator-credential-must-not-render";
    const previous = process.env.OPERATOR_TOKEN_ENV;
    process.env.OPERATOR_TOKEN_ENV = canary;
    try {
      const source = renderSpawnfile(manifest);
      expect(manifestSchema.parse(YAML.parse(source))).toEqual(manifest);
      expect(source).toContain("secret: OPERATOR_TOKEN_ENV");
      expect(source).toContain("secret: RED_TOKEN_ENV");
      expect(source).toContain("secret: WORLD_TOKEN_ENV");
      expect(source).not.toContain(canary);
      const external = source.indexOf("external_participants:");
      const network = source.indexOf("- network: pitch", external);
      expect(network).toBeGreaterThan(external);
      expect(source.indexOf("auth:", network)).toBeLessThan(source.indexOf("dms:", network));
    } finally {
      if (previous === undefined) delete process.env.OPERATOR_TOKEN_ENV;
      else process.env.OPERATOR_TOKEN_ENV = previous;
    }
  });
});
