import { SpawnfileError } from "../shared/index.js";

import type { CompilePlan, ResolvedTeamNode } from "./types.js";

const rootTeamNode = (plan: CompilePlan): ResolvedTeamNode => {
  const rootNodes = plan.nodes
    .map((entry) =>
      entry.kind === "team" &&
      entry.value.kind === "team" &&
      entry.value.source === plan.root
        ? entry.value
        : undefined
    )
    .filter((team): team is ResolvedTeamNode => Boolean(team));

  if (rootNodes.length !== 1) {
    throw new SpawnfileError(
      "validation_error",
      `Moltnet attachment validation requires exactly one source-root team; found ${rootNodes.length}`
    );
  }

  return rootNodes[0];
};

const describeAttachment = (network: string, memberId: string | null): string =>
  `${network}/${memberId ?? "unknown"}`;

export const validateAllowedWakeSenders = (plan: CompilePlan): void => {
  let rootTeam: ResolvedTeamNode | undefined;
  const rootParticipants = (): NonNullable<ResolvedTeamNode["externalParticipants"]> => {
    if (!rootTeam) {
      rootTeam = rootTeamNode(plan);
    }

    return rootTeam.externalParticipants ?? [];
  };

  for (const node of plan.nodes) {
    if (node.value.kind !== "agent") continue;
    const attachments = node.value.surfaces?.moltnet ?? [];

    for (const attachment of attachments) {
      if (!attachment.dms?.allowedWakeSenders?.length) {
        continue;
      }

      const rootNodeParticipants = rootParticipants();

      for (const authorId of attachment.dms.allowedWakeSenders) {
        const compatible = rootNodeParticipants.filter((service) =>
          service.id === authorId &&
          service.surfaces.moltnet.some(
            (entry) => entry.network === attachment.network && entry.dms.enabled === true
          )
        );

        if (compatible.length !== 1) {
          throw new SpawnfileError(
            "validation_error",
            `Moltnet attachment ${node.value.name}/${describeAttachment(
              attachment.network,
              attachment.memberId
            )} has ${compatible.length} root matches for allowed_wake_senders entry ${authorId}`
          );
        }
      }
    }
  }
};
