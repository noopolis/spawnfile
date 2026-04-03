import { SpawnfileError } from "../shared/index.js";

import type {
  ResolvedMoltnetAttachment,
  ResolvedTeamNetwork
} from "./types.js";

export interface MoltnetTeamContext {
  memberId: string;
  teamName: string;
  teamSource: string;
  networks: ResolvedTeamNetwork[];
}

const cloneAttachment = (
  attachment: ResolvedMoltnetAttachment,
  context: MoltnetTeamContext
): ResolvedMoltnetAttachment => ({
  ...(attachment.dms ? { dms: { ...attachment.dms } } : {}),
  memberId: context.memberId,
  network: attachment.network,
  ...(attachment.rooms
    ? {
        rooms: Object.fromEntries(
          Object.entries(attachment.rooms).map(([roomId, policy]) => [
            roomId,
            { ...policy }
          ])
        )
      }
    : {}),
  teamSource: context.teamSource
});

export const resolveMoltnetAttachments = (
  attachments: ResolvedMoltnetAttachment[] | undefined,
  context: MoltnetTeamContext | undefined,
  nodeName: string
): ResolvedMoltnetAttachment[] | undefined => {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  if (!context) {
    throw new SpawnfileError(
      "validation_error",
      `Agent ${nodeName} declares Moltnet surfaces but is not attached to a team network`
    );
  }

  return attachments.map((attachment) => {
    const network = context.networks.find((entry) => entry.id === attachment.network);
    if (!network) {
      throw new SpawnfileError(
        "validation_error",
        `Agent ${nodeName} references unknown Moltnet network ${attachment.network} on team ${context.teamName}`
      );
    }

    for (const roomId of Object.keys(attachment.rooms ?? {})) {
      const room = network.rooms.find((entry) => entry.id === roomId);
      if (!room) {
        throw new SpawnfileError(
          "validation_error",
          `Agent ${nodeName} references unknown Moltnet room ${roomId} on network ${network.id}`
        );
      }

      if (!room.members.includes(context.memberId)) {
        throw new SpawnfileError(
          "validation_error",
          `Agent ${nodeName} cannot attach to Moltnet room ${roomId} because member ${context.memberId} is not in that room`
        );
      }
    }

    return cloneAttachment(attachment, context);
  });
};
