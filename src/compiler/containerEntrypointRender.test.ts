import { describe, expect, it } from "vitest";

import { renderEntrypoint } from "./containerEntrypointRender.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";

const serverPlan = (): MoltnetArtifacts["serverPlans"][number] =>
  ({
    baseUrl: "http://127.0.0.1:19187",
    configPath: "/var/lib/spawnfile/moltnet/servers/org-dist_lab/Moltnet.json",
    id: "org-dist_lab",
    mode: "managed",
    name: "Dist Lab",
    networkId: "dist_lab",
    port: 19187,
    rooms: [{ id: "room", members: ["coordinator"] }],
    secretPatches: [],
    server: {
      mode: "managed",
      store: { kind: "sqlite", path: "/x" }
    },
    teamSource: "/p/Spawnfile"
  }) as unknown as MoltnetArtifacts["serverPlans"][number];

const nodePlan = (): MoltnetArtifacts["nodePlans"][number] => ({
  configPath: "/var/lib/spawnfile/moltnet/nodes/dist_lab.json",
  networkId: "dist_lab"
});

describe("renderEntrypoint network binding", () => {
  it("suppresses the in-image managed server when the network URL is bound", () => {
    const script = renderEntrypoint([], [], {
      hasMoltnet: true,
      moltnet: { nodePlans: [], serverPlans: [serverPlan()] }
    });
    expect(script).toContain('if [ -z "${SPAWNFILE_NETWORK_DIST_LAB_URL:-}" ]; then');
    // The server start and healthz wait live inside the guarded block.
    const guardIndex = script.indexOf("SPAWNFILE_NETWORK_DIST_LAB_URL");
    const serverIndex = script.indexOf("/usr/local/bin/moltnet &");
    expect(serverIndex).toBeGreaterThan(guardIndex);
    expect(script).toContain("/healthz");
  });

  it("rebinds bridge node base_url when the network URL is provided", () => {
    const script = renderEntrypoint([], [], {
      hasMoltnet: true,
      moltnet: { nodePlans: [nodePlan()], serverPlans: [] }
    });
    expect(script).toContain('if [ -n "${SPAWNFILE_NETWORK_DIST_LAB_URL:-}" ]; then');
    expect(script).toContain(
      "apply_json_env_value '/var/lib/spawnfile/moltnet/nodes/dist_lab.json' 'SPAWNFILE_NETWORK_DIST_LAB_URL' 'moltnet.base_url'"
    );
    expect(script).toContain(
      "/usr/local/bin/moltnet node '/var/lib/spawnfile/moltnet/nodes/dist_lab.json'"
    );
  });
});
