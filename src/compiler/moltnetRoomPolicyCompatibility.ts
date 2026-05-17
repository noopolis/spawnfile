import { SpawnfileError } from "../shared/index.js";
import type { TeamNetworkServer } from "../manifest/index.js";

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const assertCompatibleMoltnetNetworkName = (
  networkId: string,
  existing: string | undefined,
  next: string | undefined
): void => {
  if (existing !== undefined && next !== undefined && existing !== next) {
    throw new SpawnfileError(
      "validation_error",
      `Duplicate Moltnet network ${networkId} declares conflicting network name: ${existing} vs ${next}`
    );
  }
};

export const assertCompatibleMoltnetServer = (
  networkId: string,
  existing: TeamNetworkServer,
  next: TeamNetworkServer
): void => {
  if (stableStringify(existing.auth) !== stableStringify(next.auth)) {
    throw new SpawnfileError(
      "validation_error",
      `Duplicate Moltnet network ${networkId} declares conflicting server.auth policy`
    );
  }

  if (stableStringify(existing) !== stableStringify(next)) {
    throw new SpawnfileError(
      "validation_error",
      `Duplicate Moltnet network ${networkId} declares conflicting server definition`
    );
  }
};

export const assertCompatibleMoltnetRoomPolicy = (
  networkId: string,
  roomId: string,
  field: "visibility" | "write_policy",
  existing: string | undefined,
  next: string | undefined
): void => {
  if (existing !== undefined && next !== undefined && existing !== next) {
    throw new SpawnfileError(
      "validation_error",
      `Duplicate Moltnet network ${networkId} room ${roomId} declares conflicting ${field}: ${existing} vs ${next}`
    );
  }
};
