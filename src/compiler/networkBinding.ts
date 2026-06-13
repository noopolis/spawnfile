import { SpawnfileError } from "../shared/index.js";

const ENV_PREFIX = "SPAWNFILE_NETWORK_";

/** Uppercases an id and replaces every non-[A-Z0-9] character with `_`. */
export const normalizeNetworkEnvSegment = (id: string): string =>
  id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export const networkUrlEnvName = (networkId: string): string =>
  `${ENV_PREFIX}${normalizeNetworkEnvSegment(networkId)}_URL`;

export const networkTokenEnvName = (
  networkId: string,
  memberId?: string
): string =>
  memberId === undefined
    ? `${ENV_PREFIX}${normalizeNetworkEnvSegment(networkId)}_TOKEN`
    : `${ENV_PREFIX}${normalizeNetworkEnvSegment(networkId)}_TOKEN_${normalizeNetworkEnvSegment(memberId)}`;

export interface NetworkBindingInput {
  id: string;
  members: string[];
}

/**
 * Asserts that every generated network binding env name (URL and token vars,
 * across all networks and members) is globally unique after normalization.
 * Collisions are baked into immutable images, so they must fail at compile.
 */
export const assertNetworkBindingEnvUniqueness = (
  networks: NetworkBindingInput[]
): void => {
  const seen = new Map<string, string>();
  const claim = (envName: string, owner: string): void => {
    const existing = seen.get(envName);
    if (existing && existing !== owner) {
      throw new SpawnfileError(
        "validation_error",
        `Network binding env name ${envName} collides between ${existing} and ${owner}. ` +
          "Rename a network or member so their normalized env names stay unique."
      );
    }
    seen.set(envName, owner);
  };

  for (const network of networks) {
    claim(networkUrlEnvName(network.id), `network ${network.id} url`);
    const members = [...new Set(network.members)];
    if (members.length === 1) {
      claim(networkTokenEnvName(network.id), `network ${network.id} token`);
    }
    for (const member of members) {
      claim(networkTokenEnvName(network.id, member), `network ${network.id} member ${member}`);
    }
  }
};
