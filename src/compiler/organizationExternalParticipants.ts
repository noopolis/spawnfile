import { SpawnfileError } from "../shared/index.js";
import type { TeamNetworkServer } from "../manifest/index.js";
import type {
  CompilePlan,
  MoltnetExternalParticipantIntent,
  ResolvedAgentNode,
} from "./types.js";
import {
  assertOrganizationSegment,
  compareOrganizationIds,
  exactOrganizationStrings,
  organizationAgentPaths,
  organizationIdentityFail,
  requiredOrganizationIdentity,
  rootOrganizationTeam,
} from "./organizationIdentityGraph.js";
const actorTokenFor = (
  server: Extract<TeamNetworkServer, { mode: "managed" }>,
  tokenId: string,
  memberId: string,
  allowObserve = false,
) => {
  const token = server.auth.tokens?.filter((entry) => entry.id === tokenId);
  if (token?.length !== 1) {
    organizationIdentityFail(`Moltnet actor token ${tokenId} must exist exactly once`);
  }
  const selected = requiredOrganizationIdentity(
    token?.[0], `Moltnet actor token ${tokenId} must exist exactly once`,
  );
  const validScopes = exactOrganizationStrings(selected.scopes, ["attach", "write"])
    || allowObserve && exactOrganizationStrings(selected.scopes, ["attach", "observe", "write"]);
  if (!validScopes || !exactOrganizationStrings(selected.agents, [memberId])) {
    organizationIdentityFail(`Moltnet actor token ${tokenId} has invalid scopes or agents for ${memberId}`);
  }
  return selected;
};

const validateB31Networks = (plan: CompilePlan): Set<string> => {
  const root = requiredOrganizationIdentity(rootOrganizationTeam(plan), "B31 root team is missing");
  const services = requiredOrganizationIdentity(root.externalParticipants, "B31 participants are missing");
  const networkIds = new Set(
    services.flatMap((service) => service.surfaces.moltnet.map((attachment) => attachment.network)),
  );
  for (const network of root.networks ?? []) {
    if (!networkIds.has(network.id)) continue;
    assertOrganizationSegment(network.id, "B31 network id");
    if (network.server?.mode !== "managed" || network.server.auth.mode !== "bearer"
      || network.server.direct_messages !== true) {
      organizationIdentityFail(`B31 network ${network.id} requires managed bearer direct_messages`);
    }
    const server = requiredOrganizationIdentity(
      network.server, `B31 network ${network.id} requires a managed server`,
    ) as Extract<TeamNetworkServer, { mode: "managed" }>;
    if (JSON.stringify(server.auth.client) !== JSON.stringify({ token_id: "operator" })) {
      organizationIdentityFail(`B31 network ${network.id} requires auth.client token_id operator`);
    }
    const tokens = server.auth.tokens ?? [];
    const operator = tokens.find((token) => token.id === "operator");
    if (tokens.filter((token) => token.id === "operator").length !== 1 || !operator
      || operator.agents !== undefined
      || !exactOrganizationStrings(operator.scopes, ["admin", "observe", "write"])) {
      organizationIdentityFail(`B31 network ${network.id} has invalid operator token`);
    }
    const resolvedOperator = requiredOrganizationIdentity(
      operator, `B31 network ${network.id} has invalid operator token`,
    );
    const usedTokenIds = new Set<string>();
    const usedEnvNames = new Set<string>();
    for (const token of tokens) {
      assertOrganizationSegment(token.id, "Moltnet token id");
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(token.secret)) {
        organizationIdentityFail(`invalid Moltnet token env name ${token.secret}`);
      }
      if (usedTokenIds.has(token.id) || usedEnvNames.has(token.secret)) {
        organizationIdentityFail(`duplicate Moltnet token identity ${token.id}`);
      }
      usedTokenIds.add(token.id);
      usedEnvNames.add(token.secret);
      if (token.id !== "operator" && token.secret === resolvedOperator.secret) {
        organizationIdentityFail("operator and actor token env identities must differ");
      }
    }
  }
  return networkIds;
};

export const validateB31MoltnetAuth = (plan: CompilePlan): void => {
  const root = rootOrganizationTeam(plan);
  if (!root?.externalParticipants?.length) return;
  const identity = requiredOrganizationIdentity(
    plan.organizationIdentity, "B31 organization identity is missing",
  );
  const paths = organizationAgentPaths(plan);
  const networkIds = validateB31Networks(plan);
  const selectedByNetwork = new Map<string, Map<string, string>>();
  const selectedActorKeys = new Set<string>();
  for (const member of identity.agentMembers) {
    const source = [...paths.entries()].find(([, path]) => path.join(".") === member.memberId)?.[0];
    const node = plan.nodes.find((entry) => entry.kind === "agent"
      && (entry.value as ResolvedAgentNode).source === source);
    const attachments = (node?.value as ResolvedAgentNode | undefined)?.surfaces?.moltnet ?? [];
    for (const attachment of attachments.filter((entry) => networkIds.has(entry.network))) {
      const network = root.networks?.find((entry) => entry.id === attachment.network);
      const selectedTokenId = requiredOrganizationIdentity(
        attachment.auth?.tokenId, `B31 agent ${member.memberId} must select auth.token_id`,
      );
      const actorKey = `${attachment.network}\u0000${member.memberId}`;
      if (selectedActorKeys.has(actorKey)) {
        organizationIdentityFail(`B31 actor ${member.memberId} selects more than one token on ${attachment.network}`);
      }
      selectedActorKeys.add(actorKey);
      if (network?.server?.mode === "managed") {
        const token = actorTokenFor(network.server, selectedTokenId, member.memberId);
        const selected = selectedByNetwork.get(attachment.network) ?? new Map<string, string>();
        const previous = selected.get(selectedTokenId);
        if (previous) {
          organizationIdentityFail(`Moltnet actor token ${selectedTokenId} is shared by ${previous} and ${member.memberId}`);
        }
        selected.set(selectedTokenId, member.memberId);
        selectedByNetwork.set(attachment.network, selected);
        if (token.id === "operator") {
          organizationIdentityFail(`B31 actor ${member.memberId} must not use operator token`);
        }
      }
    }
  }
  for (const service of root.externalParticipants) {
    for (const attachment of service.surfaces.moltnet) {
      const network = root.networks?.find((entry) => entry.id === attachment.network);
      if (network?.server?.mode !== "managed") continue;
      const token = actorTokenFor(network.server, attachment.auth.token_id, service.id, true);
      if (token.id === "operator") {
        organizationIdentityFail(`B31 external participant ${service.id} must not use operator token`);
      }
      const selected = selectedByNetwork.get(attachment.network) ?? new Map<string, string>();
      const previous = selected.get(token.id);
      if (previous) organizationIdentityFail(`Moltnet actor token ${token.id} is shared by ${previous} and ${service.id}`);
      selected.set(token.id, service.id);
      selectedByNetwork.set(attachment.network, selected);
    }
  }
  for (const network of root.networks ?? []) {
    const selected = selectedByNetwork.get(network.id);
    if (network.server?.mode !== "managed" || !selected) continue;
    for (const token of network.server.auth.tokens ?? []) {
      if (token.id !== "operator" && !selected.has(token.id)) {
        organizationIdentityFail(`Moltnet actor token ${token.id} is not selected by exactly one actor`);
      }
    }
  }
};

export const resolveMoltnetExternalParticipantIntents = (
  plan: CompilePlan,
): MoltnetExternalParticipantIntent[] => {
  const identity = plan.organizationIdentity;
  const root = rootOrganizationTeam(plan);
  if (!identity || !root?.externalParticipants?.length) return [];
  const paths = organizationAgentPaths(plan);
  const agents = new Map(identity.agentMembers.map((member) => [member.memberId, member]));
  const networkIds = new Set((root.networks ?? []).map((network) => network.id));
  const result: MoltnetExternalParticipantIntent[] = [];
  for (const service of root.externalParticipants) {
    const participant = identity.externalParticipants.find((entry) => entry.memberId === service.id);
    if (!participant) {
      throw new SpawnfileError("validation_error", `missing external participant identity: ${service.id}`);
    }
    for (const attachment of service.surfaces.moltnet) {
      if (!networkIds.has(attachment.network)) {
        organizationIdentityFail(`external participant ${service.id} references unknown network ${attachment.network}`);
      }
      const peers: string[] = [];
      for (const [memberId, agent] of agents) {
        const node = plan.nodes.find((entry) => entry.kind === "agent"
          && paths.get(entry.value.source)?.join(".") === memberId);
        const authored = (node?.value as ResolvedAgentNode | undefined)?.surfaces?.moltnet ?? [];
        const eligible = authored.filter((entry) =>
          entry.network === attachment.network && entry.dms?.enabled === true);
        if (eligible.length > 1) {
          organizationIdentityFail(`duplicate eligible Moltnet peer for ${service.id}/${attachment.network}`);
        }
        if (eligible.length === 1) peers.push(agent.memberId);
      }
      if (new Set(peers).size !== peers.length) {
        organizationIdentityFail(`duplicate eligible Moltnet peer for ${service.id}/${attachment.network}`);
      }
      if (peers.length === 0) {
        organizationIdentityFail(`external participant ${service.id}/${attachment.network} has no eligible direct-message peers`);
      }
      peers.sort(compareOrganizationIds);
      const network = root.networks?.find((entry) => entry.id === attachment.network);
      const token = network?.server?.mode === "managed"
        ? actorTokenFor(network.server, attachment.auth.token_id, service.id, true)
        : undefined;
      result.push({ participant, networkId: attachment.network, tokenId: attachment.auth.token_id,
        tokenEnv: token?.secret ?? "", directMessagePeers: peers });
    }
  }
  return result;
};
