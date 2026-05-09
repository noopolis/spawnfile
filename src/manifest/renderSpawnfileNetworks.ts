import type { TeamManifest, TeamNetwork, TeamNetworkServer } from "./schemas.js";

const withDefinedEntries = (entries: Array<[string, unknown]>): Record<string, unknown> =>
  Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));

const orderTeamAuthToken = (token: {
  agents?: string[];
  id: string;
  scopes: string[];
}): unknown =>
  withDefinedEntries([
    ["id", token.id],
    ["agents", token.agents],
    ["scopes", token.scopes]
  ]);

const orderTeamAuthPairing = (pairing: {
  id: string;
  remote_base_url: string;
  remote_network_id: string;
  remote_network_name: string;
}): unknown =>
  withDefinedEntries([
    ["id", pairing.id],
    ["remote_base_url", pairing.remote_base_url],
    ["remote_network_id", pairing.remote_network_id],
    ["remote_network_name", pairing.remote_network_name]
  ]);

const orderTeamAuth = (server: TeamNetworkServer): TeamNetworkServer =>
  withDefinedEntries([
    ["mode", server.mode],
    ["url", server.url],
    ["listen", server.mode === "managed" ? server.listen : undefined],
    [
      "auth",
      withDefinedEntries([
        ["mode", server.auth.mode],
        ["tokens", server.auth.tokens?.map(orderTeamAuthToken)],
        [
          "client",
          server.auth.client
            ? withDefinedEntries([
                ["static_token", server.auth.client.static_token],
                ["token_id", server.auth.client.token_id],
                ["token_env", server.auth.client.token_env],
                ["token_path", server.auth.client.token_path]
              ])
            : undefined
        ]
      ])
    ],
    ["store", server.mode === "managed" ? server.store : undefined],
    [
      "pairings",
      server.mode === "managed" && server.pairings
        ? server.pairings.map(orderTeamAuthPairing)
        : undefined
    ],
    ["human_ingress", server.mode === "managed" ? server.human_ingress : undefined],
    ["direct_messages", server.mode === "managed" ? server.direct_messages : undefined],
    [
      "trust_forwarded_proto",
      server.mode === "managed" ? server.trust_forwarded_proto : undefined
    ],
    ["allowed_origins", server.mode === "managed" ? server.allowed_origins : undefined]
  ]) as unknown as TeamNetworkServer;

export const orderTeamNetworks = (
  networks: TeamManifest["networks"]
): TeamManifest["networks"] | undefined =>
  networks?.map((network) =>
    withDefinedEntries([
      ["id", network.id],
      ["provider", network.provider],
      ["name", network.name],
      ["server", orderTeamAuth(network.server)],
      [
        "rooms",
        network.rooms.map((room) =>
          withDefinedEntries([
            ["id", room.id],
            ["name", room.name],
            ["members", room.members]
          ])
        )
      ]
    ]) as TeamNetwork
  );
