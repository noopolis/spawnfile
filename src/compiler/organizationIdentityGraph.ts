import { SpawnfileError } from "../shared/index.js";
import type { CompilePlan, ResolvedTeamNode } from "./types.js";

export const ORGANIZATION_ID_SEGMENT_PATTERN_SOURCE = "^[a-z][a-z0-9-]{0,62}$";
export const ORGANIZATION_MEMBER_ID_PATTERN_SOURCE = "^[a-z][a-z0-9-]{0,62}(\\.[a-z][a-z0-9-]{0,62}){0,7}$";
export const MAX_ORGANIZATION_MEMBER_DEPTH = 8;
export const MAX_ORGANIZATION_MEMBER_ID_BYTES = 255;
export const MAX_ORGANIZATION_AGENT_MEMBERS = 128;
export const MAX_EXTERNAL_PARTICIPANTS = 32;

const segment = new RegExp(ORGANIZATION_ID_SEGMENT_PATTERN_SOURCE, "u");

export const organizationIdentityFail = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};
export const requiredOrganizationIdentity = <T>(
  value: T,
  message: string,
): NonNullable<T> => value == null ? organizationIdentityFail(message) : value as NonNullable<T>;
export const assertOrganizationSegment = (value: string, label: string): void => {
  if (!segment.test(value)) {
    organizationIdentityFail(`${label} must match ${ORGANIZATION_ID_SEGMENT_PATTERN_SOURCE}`);
  }
};
export const freezeOrganizationIdentity = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeOrganizationIdentity(child);
    }
  }
  return value;
};
export const compareOrganizationIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
export const exactOrganizationStrings = (
  actual: readonly string[] | undefined,
  expected: readonly string[],
): boolean => actual?.length === expected.length
  && actual.every((value, index) => value === expected[index]);

const teamNodes = (plan: CompilePlan): Map<string, ResolvedTeamNode> => new Map(
  plan.nodes.filter((node) => node.kind === "team")
    .map((node) => [node.value.source, node.value as ResolvedTeamNode]),
);

export const rootOrganizationTeam = (plan: CompilePlan): ResolvedTeamNode | undefined => {
  const node = plan.nodes.find((entry) => entry.id === plan.root || entry.value.source === plan.root);
  return node?.value.kind === "team" ? node.value : undefined;
};

export const organizationAgentPaths = (plan: CompilePlan): Map<string, string[]> => {
  const teams = teamNodes(plan);
  const edges = plan.edges.filter((edge) => edge.kind === "team_member");
  const paths = new Map<string, string[]>();
  const teamPaths = new Map<string, string[]>();
  const visitedNodeIds = new Set<string>();
  // External-participant authority needs one unambiguous path per principal.
  // Ordinary organizations still have a canonical identity, but retain the
  // compiler's long-standing ability to reuse an identical agent/team ref.
  const requireUniquePaths = (rootOrganizationTeam(plan)?.externalParticipants?.length ?? 0) > 0;
  const walk = (source: string, prefix: string[], seen: Set<string>): void => {
    if (seen.has(source)) organizationIdentityFail(`organization member graph cycle at ${source}`);
    const team = teams.get(source);
    if (!team) return;
    if (teamPaths.has(source)) {
      if (requireUniquePaths) {
        organizationIdentityFail(`team is reached through multiple organization paths: ${source}`);
      }
      return;
    }
    teamPaths.set(source, prefix);
    const node = plan.nodes.find((entry) => entry.value.source === source);
    if (!node || node.kind !== "team") {
      throw new SpawnfileError("validation_error", `organization graph references missing team ${source}`);
    }
    visitedNodeIds.add(node.id);
    const outgoing = edges.filter((entry) => entry.from === node.id)
      .sort((left, right) => compareOrganizationIds(left.label, right.label));
    const memberSlots = new Set(team.members.map((member) => member.id));
    if (memberSlots.size !== team.members.length || outgoing.length !== team.members.length) {
      organizationIdentityFail(`organization graph cardinality mismatch for team ${team.name}`);
    }
    const localSlots = new Set<string>();
    for (const edge of outgoing) {
      if (localSlots.has(edge.label)) {
        organizationIdentityFail(`duplicate organization member slot: ${edge.label}`);
      }
      localSlots.add(edge.label);
      assertOrganizationSegment(edge.label, "organization member slot");
      const next = [...prefix, edge.label];
      if (next.length > MAX_ORGANIZATION_MEMBER_DEPTH) {
        organizationIdentityFail("organization member depth exceeds 8");
      }
      const child = plan.nodes.find((candidate) => candidate.id === edge.to);
      if (!child) {
        throw new SpawnfileError("validation_error", `organization graph references missing node ${edge.to}`);
      }
      const member = team.members.find((entry) => entry.id === edge.label);
      if (!member || member.kind !== child.kind || member.nodeSource !== child.value.source) {
        organizationIdentityFail(`organization graph member edge mismatch: ${edge.label}`);
      }
      if (child.kind === "agent") {
        if (paths.has(child.value.source) && requireUniquePaths) {
          organizationIdentityFail(`agent source is reached through multiple organization paths: ${child.value.source}`);
        }
        const prior = paths.get(child.value.source);
        if (!prior || compareOrganizationIds(next.join("."), prior.join(".")) < 0) {
          paths.set(child.value.source, next);
        }
        visitedNodeIds.add(child.id);
      } else {
        walk(child.value.source, next, new Set([...seen, source]));
      }
    }
  };
  walk(plan.root, [], new Set());
  const rootNode = plan.nodes.find((node) => node.value.source === plan.root);
  const organizationNodeIds = new Set<string>(rootNode ? [rootNode.id] : []);
  for (const edge of edges) {
    organizationNodeIds.add(edge.from);
    organizationNodeIds.add(edge.to);
  }
  const extra = plan.nodes.find((node) =>
    organizationNodeIds.has(node.id) && !visitedNodeIds.has(node.id));
  if (extra) organizationIdentityFail(`unreachable organization graph node: ${extra.id}`);
  return paths;
};
