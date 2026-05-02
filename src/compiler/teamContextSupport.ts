import YAML from "yaml";

import type { CapabilityReport, DiagnosticReport } from "../report/index.js";
import type { EmittedFile } from "../runtime/index.js";

import {
  buildContextOrientation,
  collectMoltnetBindings,
  createContextBaseKey,
  createVisibleTeamCards,
  findAgentBySource,
  findTeamBySource,
  getSystemTeamDoc,
  reportKeySegment,
  shortHash
} from "./teamContextHelpers.js";
import type { AgentContext, TeamCompileSupport } from "./teamContextTypes.js";
export type { TeamCompileSupport } from "./teamContextTypes.js";
import {
  generateTeamRoster,
  listTeamRepresentatives
} from "./teamRoster.js";
import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "./types.js";

const assignContextKeys = (contexts: AgentContext[]): void => {
  const baseCounts = new Map<string, number>();
  for (const context of contexts) {
    const base = createContextBaseKey(context);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  const used = new Set<string>();
  for (const context of contexts) {
    const base = createContextBaseKey(context);
    const tuple = context.kind === "direct"
      ? `direct:${context.membership.teamSource}:${context.membership.memberId}`
      : `representative:${context.parentTeamNode.source}:${context.representedMember.id}:${context.representativeMemberId}`;
    const key = baseCounts.get(base) === 1 && !used.has(base)
      ? base
      : `${base}--${shortHash(tuple)}`;
    context.contextKey = key;
    used.add(key);
  }
};

const collectAgentContexts = (plan: CompilePlan): Map<string, AgentContext[]> => {
  const contextsByAgent = new Map<string, AgentContext[]>();
  const addContext = (agentSource: string, context: AgentContext): void => {
    const contexts = contextsByAgent.get(agentSource) ?? [];
    contexts.push(context);
    contextsByAgent.set(agentSource, contexts);
  };

  for (const membership of plan.memberships ?? []) {
    const teamNode = findTeamBySource(plan, membership.teamSource);
    if (teamNode) {
      addContext(membership.agentSource, {
        contextKey: "",
        kind: "direct",
        membership,
        teamNode
      });
    }
  }

  for (const node of plan.nodes) {
    if (node.value.kind !== "team") {
      continue;
    }

    const parentTeamNode = node.value;
    for (const member of parentTeamNode.members.filter((entry) => entry.kind === "team")) {
      const childTeam = findTeamBySource(plan, member.nodeSource);
      if (!childTeam) {
        continue;
      }

      const delegateRole = member.id === parentTeamNode.lead ? "lead" : "representative";
      for (const representative of listTeamRepresentatives(plan, childTeam)) {
        addContext(representative.agentSource, {
          contextKey: "",
          delegateRole,
          kind: "representative",
          parentTeamNode,
          representedMember: member,
          representativeMemberId: representative.memberId,
          representativeSource: representative.agentSource
        });
      }
    }
  }

  for (const contexts of contextsByAgent.values()) {
    assignContextKeys(contexts);
  }

  return contextsByAgent;
};

const addMapEntries = <T>(
  target: Map<string, T[]>,
  key: string,
  entries: T[]
): void => {
  if (entries.length === 0) {
    return;
  }
  target.set(key, [...(target.get(key) ?? []), ...entries]);
};

const createTeamCapabilities = (teamNode: ResolvedTeamNode): CapabilityReport[] => [
  {
    key: "team.roster",
    message: "Context-scoped team rosters were emitted",
    outcome: "supported"
  },
  {
    key: "team.context_orientation",
    message: "Team context orientation was surfaced through runtime system instructions",
    outcome: "supported"
  },
  {
    key: "team.representatives",
    message: "Representative chains were resolved",
    outcome: "supported"
  },
  ...((teamNode.networks?.length ?? 0) > 0
    ? [
        {
          key: "team.networks",
          message: "Team networks were lowered",
          outcome: "supported" as const
        },
        {
          key: "team.networks.moltnet",
          message: "Moltnet team networks were lowered",
          outcome: "supported" as const
        },
        ...(teamNode.networks ?? []).map((network) => ({
          key: `team.networks.moltnet.${reportKeySegment(network.id)}`,
          message: `Moltnet network ${network.id} was lowered`,
          outcome: "supported" as const
        }))
      ]
    : [])
];

const createRepresentativeDiagnostics = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode
): DiagnosticReport[] => {
  const diagnostics: DiagnosticReport[] = [];

  for (const member of teamNode.members.filter((entry) => entry.kind === "team")) {
    const childTeam = findTeamBySource(plan, member.nodeSource);
    if (!childTeam) {
      continue;
    }

    if (childTeam.mode === "swarm" && !childTeam.externalExplicit) {
      diagnostics.push({
        level: "warn",
        message: `Nested swarm team ${childTeam.name} is exposed without explicit external representatives`
      });
    }

    if (teamNode.lead === member.id && !childTeam.externalExplicit) {
      const representatives = listTeamRepresentatives(plan, childTeam);
      if (representatives.length > 1) {
        diagnostics.push({
          level: "warn",
          message: `Team ${teamNode.name} lead ${member.id} resolves to multiple implicit representatives`
        });
      }
    }
  }

  return diagnostics;
};

const addAmbiguousBindingDiagnostics = (
  agentNode: ResolvedAgentNode,
  contexts: AgentContext[],
  diagnosticsByTeamSource: Map<string, DiagnosticReport[]>
): void => {
  const bindings = new Map<string, AgentContext[]>();

  for (const context of contexts) {
    const teamSource = context.kind === "direct"
      ? context.membership.teamSource
      : context.parentTeamNode.source;
    const memberId = context.kind === "direct"
      ? context.membership.memberId
      : context.representativeMemberId;

    for (const binding of collectMoltnetBindings(agentNode, teamSource, memberId)) {
      for (const room of binding.rooms) {
        const key = `moltnet:${binding.network}:${room}`;
        bindings.set(key, [...(bindings.get(key) ?? []), context]);
      }
    }
  }

  for (const [binding, bindingContexts] of bindings) {
    const uniqueKeys = [...new Set(bindingContexts.map((context) => context.contextKey))];
    if (uniqueKeys.length < 2) {
      continue;
    }

    for (const context of bindingContexts) {
      const teamSource = context.kind === "direct"
        ? context.membership.teamSource
        : context.parentTeamNode.source;
      addMapEntries(diagnosticsByTeamSource, teamSource, [
        {
          level: "warn",
          message: `Agent ${agentNode.name} maps ${binding} to multiple team contexts: ${uniqueKeys.join(", ")}`
        }
      ]);
    }
  }
};

export const prepareTeamCompileSupport = async (
  plan: CompilePlan
): Promise<TeamCompileSupport> => {
  const capabilitiesByTeamSource = new Map<string, CapabilityReport[]>();
  const diagnosticsByTeamSource = new Map<string, DiagnosticReport[]>();
  const filesByAgentSource = new Map<string, EmittedFile[]>();
  const contextsByAgent = collectAgentContexts(plan);

  for (const node of plan.nodes) {
    if (node.value.kind !== "team") {
      continue;
    }

    addMapEntries(capabilitiesByTeamSource, node.value.source, createTeamCapabilities(node.value));
    addMapEntries(diagnosticsByTeamSource, node.value.source, createRepresentativeDiagnostics(plan, node.value));
  }

  for (const [agentSource, contexts] of contextsByAgent) {
    const agentNode = findAgentBySource(plan, agentSource);
    if (!agentNode) {
      continue;
    }

    const directCount = contexts.filter((context) => context.kind === "direct").length;
    const directIndex: Array<Record<string, unknown>> = [];
    const representationIndex: Array<Record<string, unknown>> = [];
    const files: EmittedFile[] = [];

    for (const context of contexts) {
      if (context.kind === "direct") {
        const teamDocPath = `.spawnfile/team-contexts/${context.contextKey}/TEAM.md`;
        const rosterPath = `.spawnfile/rosters/${context.contextKey}.yaml`;
        const generated = generateTeamRoster(context.teamNode, plan, {
          contextKey: context.contextKey,
          selfMemberId: context.membership.memberId,
          teamSource: context.membership.teamSource
        });
        const aliases = directCount === 1
          ? { roster: ".spawnfile/roster.yaml", team_doc: "TEAM.md" }
          : undefined;

        files.push(
          { content: getSystemTeamDoc(context.teamNode), path: teamDocPath },
          { content: generated.roster, path: rosterPath },
          ...createVisibleTeamCards(plan, context.contextKey, context.teamNode, generated.visibleMembers)
        );
        if (aliases) {
          files.push(
            { content: getSystemTeamDoc(context.teamNode), path: aliases.team_doc },
            { content: generated.roster, path: aliases.roster }
          );
        }

        directIndex.push({
          ...(aliases ? { aliases } : {}),
          context_key: context.contextKey,
          member: context.membership.memberId,
          roster: rosterPath,
          surfaces: {
            moltnet: collectMoltnetBindings(
              agentNode,
              context.membership.teamSource,
              context.membership.memberId
            )
          },
          team: context.teamNode.name,
          team_doc: teamDocPath
        });
        addMapEntries(diagnosticsByTeamSource, context.teamNode.source, generated.diagnostics);
      } else {
        const teamDocPath = `.spawnfile/team-contexts/${context.contextKey}/TEAM.md`;
        const rosterPath = `.spawnfile/rosters/${context.contextKey}.yaml`;
        const generated = generateTeamRoster(context.parentTeamNode, plan, {
          contextKey: context.contextKey,
          delegateRole: context.delegateRole,
          representedSlotId: context.representedMember.id,
          selfMemberId: context.representativeMemberId,
          teamSource: context.parentTeamNode.source
        });
        const cards = createVisibleTeamCards(
          plan,
          context.contextKey,
          context.parentTeamNode,
          generated.visibleMembers
        );

        files.push(
          { content: getSystemTeamDoc(context.parentTeamNode), path: teamDocPath },
          { content: generated.roster, path: rosterPath },
          ...cards
        );
        representationIndex.push({
          cards: cards.map((file) => file.path),
          context_key: context.contextKey,
          delegate_role: context.delegateRole,
          representative: context.representativeMemberId,
          represents: context.representedMember.id,
          roster: rosterPath,
          surfaces: {
            moltnet: collectMoltnetBindings(
              agentNode,
              context.parentTeamNode.source,
              context.representativeMemberId
            )
          },
          team: context.parentTeamNode.name,
          team_doc: teamDocPath
        });
        addMapEntries(diagnosticsByTeamSource, context.parentTeamNode.source, generated.diagnostics);
      }
    }

    const contextIndex = {
      direct_memberships: directIndex,
      representations: representationIndex
    };
    files.push(
      {
        content: YAML.stringify(contextIndex),
        path: ".spawnfile/team-contexts.yaml"
      },
      {
        content: buildContextOrientation(contextIndex),
        path: ".spawnfile/team-contexts.md"
      }
    );
    filesByAgentSource.set(agentSource, files);
    addAmbiguousBindingDiagnostics(agentNode, contexts, diagnosticsByTeamSource);
  }

  return { capabilitiesByTeamSource, diagnosticsByTeamSource, filesByAgentSource };
};
