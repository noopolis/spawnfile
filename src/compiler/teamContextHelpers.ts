import { createHash } from "node:crypto";

import type { EmittedFile } from "../runtime/index.js";

import {
  generateTeamRoster,
  listTeamRepresentatives
} from "./teamRoster.js";
import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedMemberRef,
  ResolvedTeamNode
} from "./types.js";
import type { AgentContext, TeamContextIndex } from "./teamContextTypes.js";

export const pathSafe = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "context";
};

export const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

export const reportKeySegment = (value: string): string =>
  /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : encodeURIComponent(value).replace(/\./g, "%2E");

export const findTeamBySource = (
  plan: CompilePlan,
  source: string
): ResolvedTeamNode | null => {
  const node = plan.nodes.find((entry) => entry.kind === "team" && entry.value.source === source);
  return node?.value.kind === "team" ? node.value : null;
};

export const findAgentBySource = (
  plan: CompilePlan,
  source: string
): ResolvedAgentNode | null => {
  const node = plan.nodes.find((entry) => entry.kind === "agent" && entry.value.source === source);
  return node?.value.kind === "agent" ? node.value : null;
};

export const getSystemTeamDoc = (teamNode: ResolvedTeamNode): string =>
  teamNode.docs.find((doc) => doc.role === "system")?.content ?? "";

export const createContextBaseKey = (context: AgentContext): string =>
  context.kind === "direct"
    ? pathSafe(context.teamNode.name)
    : `${pathSafe(context.parentTeamNode.name)}--${pathSafe(context.representedMember.id)}`;

export const collectMoltnetBindings = (
  agentNode: ResolvedAgentNode,
  teamSource: string,
  memberId: string
): Array<{ network: string; rooms: string[] }> =>
  (agentNode.surfaces?.moltnet ?? [])
    .filter((attachment) => attachment.memberId === memberId)
    .map((attachment) => ({
      network: attachment.network,
      rooms: [
        ...(attachment.contextRooms?.[teamSource] ??
          (attachment.teamSource === teamSource ? Object.keys(attachment.rooms ?? {}) : []))
      ].sort()
    }))
    .filter((binding) => binding.rooms.length > 0);

export const createTeamCard = (
  contextKey: string,
  member: ResolvedMemberRef,
  childTeam: ResolvedTeamNode,
  representatives: string[]
): EmittedFile => ({
  content: [
    `# ${childTeam.name}`,
    "",
    childTeam.description,
    "",
    childTeam.docs.find((doc) => doc.role === "identity")?.content ?? "",
    "## Representatives",
    "",
    ...representatives.map((representative) => `- \`${representative}\``)
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n").trimEnd() + "\n",
  path: `.spawnfile/team-cards/${contextKey}/${member.id}.md`
});

const formatMoltnetBindings = (surfaces: unknown): string[] => {
  const moltnet = (
    surfaces &&
    typeof surfaces === "object" &&
    "moltnet" in surfaces &&
    Array.isArray((surfaces as { moltnet?: unknown }).moltnet)
  )
    ? (surfaces as { moltnet: Array<{ network?: unknown; rooms?: unknown }> }).moltnet
    : [];

  return moltnet.flatMap((binding) => {
    const network = typeof binding.network === "string" ? binding.network : null;
    const rooms = Array.isArray(binding.rooms)
      ? binding.rooms.filter((room): room is string => typeof room === "string")
      : [];
    return network
      ? rooms.map((room) => `   Moltnet: \`${network}\` / room \`${room}\``)
      : [];
  });
};

const appendSurfaceBindingLines = (
  lines: string[],
  entry: Record<string, unknown>
): void => {
  const bindings = formatMoltnetBindings(entry.surfaces);
  if (bindings.length === 0) {
    return;
  }

  lines.push("   Surface bindings:");
  lines.push(...bindings);
};

export const buildContextOrientation = (index: TeamContextIndex): string => {
  const lines = ["# Spawnfile Team Context", ""];

  if (index.direct_memberships.length > 0) {
    lines.push("You are a direct member of these teams:", "");
    index.direct_memberships.forEach((entry, itemIndex) => {
      lines.push(`${itemIndex + 1}. Team: \`${entry.team}\``);
      lines.push(`   Member slot: \`${entry.member}\``);
      lines.push(`   Read \`${entry.team_doc}\` and \`${entry.roster}\`.`);
      appendSurfaceBindingLines(lines, entry);
      lines.push("");
    });
  }

  if (index.representations.length > 0) {
    lines.push("You also represent teams in parent contexts:", "");
    index.representations.forEach((entry, itemIndex) => {
      lines.push(`${itemIndex + 1}. Parent team: \`${entry.team}\``);
      lines.push(`   Represents slot: \`${entry.represents}\``);
      lines.push(`   Delegate role: \`${entry.delegate_role}\``);
      lines.push(`   Read \`${entry.team_doc}\` and \`${entry.roster}\`.`);
      appendSurfaceBindingLines(lines, entry);
      lines.push("");
    });
  }

  lines.push("Use the context matching the surface or message you are handling. Do not merge team documents.");
  lines.push("For machine-readable bindings, read `.spawnfile/team-contexts.yaml`.");
  return `${lines.join("\n").trimEnd()}\n`;
};

export const createVisibleTeamCards = (
  plan: CompilePlan,
  contextKey: string,
  teamNode: ResolvedTeamNode,
  visibleMembers: ResolvedMemberRef[]
): EmittedFile[] =>
  visibleMembers
    .filter((member) => member.kind === "team")
    .flatMap((member) => {
      const childTeam = findTeamBySource(plan, member.nodeSource);
      if (!childTeam) {
        return [];
      }

      return [
        createTeamCard(
          contextKey,
          member,
          childTeam,
          listTeamRepresentatives(plan, childTeam).map((representative) => representative.memberId)
        )
      ];
    });

export const generateContextRoster = generateTeamRoster;
