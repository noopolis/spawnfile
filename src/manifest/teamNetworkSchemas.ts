import { z } from "zod";

import {
  teamNetworkRoomFederationSchema,
  teamNetworkRoomVisibilitySchema,
  teamNetworkRoomWritePolicySchema
} from "./teamNetworkAccessSchemas.js";
import { teamNetworkServerSchema } from "./teamNetworkServerSchemas.js";

export { teamWorkspaceDocsSchema, teamWorkspaceSchema } from "./workspaceSchemas.js";
export type {
  TeamWorkspace,
  TeamWorkspaceDocs,
  TeamWorkspaceResource,
  TeamWorkspaceResource as TeamNetworkResource
} from "./workspaceSchemas.js";
export type { TeamNetworkAuth } from "./teamNetworkAuthSchemas.js";
export type { TeamNetworkServer, TeamNetworkStore } from "./teamNetworkServerSchemas.js";

const teamNetworkRoomSchema = z
  .object({
    federation: teamNetworkRoomFederationSchema.optional(),
    id: z.string().trim().min(1),
    members: z.array(z.string().trim().min(1)),
    name: z.string().trim().min(1).optional(),
    visibility: teamNetworkRoomVisibilitySchema.optional(),
    write_policy: teamNetworkRoomWritePolicySchema.optional()
  })
  .strict();

export const teamNetworkSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    provider: z.literal("moltnet"),
    rooms: z.array(teamNetworkRoomSchema).min(1),
    server: teamNetworkServerSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const roomIds = value.rooms.map((room) => room.id);
    if (new Set(roomIds).size !== roomIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `network ${value.id} declares duplicate room ids`
      });
    }
  });

export type TeamNetwork = z.infer<typeof teamNetworkSchema>;
export type TeamNetworkRoom = z.infer<typeof teamNetworkRoomSchema>;

export const isDeclaredPairedRemoteRoomMember = (
  network: TeamNetwork,
  room: TeamNetworkRoom,
  memberId: string
): boolean => {
  const separator = memberId.indexOf(":");
  if (separator <= 0 || separator === memberId.length - 1) {
    return false;
  }

  const remoteNetworkId = memberId.slice(0, separator).trim();
  const remoteAgentId = memberId.slice(separator + 1).trim();
  if (!remoteNetworkId || !remoteAgentId || network.server?.mode !== "managed") {
    return false;
  }

  const pairing = network.server.pairings?.find((candidate) =>
    candidate.remote_network_id === remoteNetworkId);
  if (!pairing) {
    return false;
  }

  return room.federation === "all"
    || (Array.isArray(room.federation) && room.federation.includes(pairing.id));
};
