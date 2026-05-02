import type { TeamManifest } from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { ResolvedTeamNetwork, ResolvedTeamNode } from "./types.js";

export const resolveTeamExternalIds = (manifest: TeamManifest): string[] => {
  const memberIds = manifest.members.map((member) => member.id);
  if (manifest.lead && !memberIds.includes(manifest.lead)) {
    throw new SpawnfileError(
      "validation_error",
      `Team ${manifest.name} lead references unknown member ${manifest.lead}`
    );
  }
  for (const externalMemberId of manifest.external ?? []) {
    if (!memberIds.includes(externalMemberId)) {
      throw new SpawnfileError(
        "validation_error",
        `Team ${manifest.name} external representative references unknown member ${externalMemberId}`
      );
    }
  }

  return manifest.external
    ?? (manifest.mode === "hierarchical" && manifest.lead
      ? [manifest.lead]
      : memberIds);
};

export const resolveTeamNetworks = (manifest: TeamManifest): ResolvedTeamNetwork[] =>
  (manifest.networks ?? []).map((network) => ({
    expose: network.expose ?? false,
    id: network.id,
    name: network.name ?? network.id,
    provider: network.provider,
    rooms: network.rooms.map((room) => ({
      id: room.id,
      members: [...room.members]
    }))
  }));

export const validateTeamNetworkRooms = (teamNode: ResolvedTeamNode): void => {
  for (const network of teamNode.networks ?? []) {
    for (const room of network.rooms) {
      for (const roomMemberId of room.members) {
        const resolvedMember = teamNode.members.find((member) => member.id === roomMemberId);
        if (!resolvedMember) {
          throw new SpawnfileError(
            "validation_error",
            `Team ${teamNode.name} Moltnet room ${room.id} references unknown member ${roomMemberId}`
          );
        }
      }
    }
  }
};
