import type { ResolvedAgentSurfaces, ResolvedMoltnetAttachment } from "./types.js";

const listMoltnetAttachmentScopes = (attachment: ResolvedMoltnetAttachment): string[] => {
  const scopes = Object.keys(attachment.rooms ?? {})
    .sort((left, right) => left.localeCompare(right))
    .map((roomId) => `moltnet:${attachment.network}:room:${roomId}`);

  if (attachment.dms?.enabled) {
    scopes.push(`moltnet:${attachment.network}:dms`);
  }

  return scopes;
};

export const listInteractiveSurfaceScopes = (
  surfaces: ResolvedAgentSurfaces | undefined
): string[] => {
  if (!surfaces) {
    return [];
  }

  return [
    ...(surfaces.discord ? ["discord"] : []),
    ...(surfaces.moltnet?.flatMap(listMoltnetAttachmentScopes) ?? []),
    ...(surfaces.slack ? ["slack"] : []),
    ...(surfaces.telegram ? ["telegram"] : []),
    ...(surfaces.whatsapp ? ["whatsapp"] : [])
  ];
};
