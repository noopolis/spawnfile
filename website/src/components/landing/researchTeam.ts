import { load } from 'js-yaml';
import source from '../../../../examples/research-org/Spawnfile?raw';
import engineerSource from '../../../../examples/research-org/opencode/Spawnfile?raw';
import teamDockerfile from '../../../public/research-org.dockerfile.txt?raw';
import agentDockerfile from '../../../public/engineer.dockerfile.txt?raw';
import { harnesses } from './harnesses';

type Runtime = string | { name: string };
type Member = { id: string; runtime: Runtime };
type Project = { kind: 'agent'; runtime: Runtime } | { kind: 'team'; members: Member[] };

const team = load(source) as {
  name: string;
  lead: string;
  members: { id: string; ref: string }[];
  networks: { rooms: { id: string; members: string[] }[] }[];
};
const projects = import.meta.glob<string>('../../../../examples/research-org/*/Spawnfile', {
  eager: true, import: 'default', query: '?raw',
});

function role({ id, runtime }: Member) {
  const runtimeId = typeof runtime === 'string' ? runtime : runtime.name;
  const guide = harnesses.find((harness) => harness.id === runtimeId);
  if (!guide) throw new Error(`Missing runtime guide for ${id}: ${runtimeId}`);
  return { id, guide, lead: id === team.lead };
}

export type ResearchRole = ReturnType<typeof role>;
const groups = team.members.map(({ id, ref }) => {
  const directory = ref.replace(/^\.\//, '');
  const project = load(projects[`../../../../examples/research-org/${directory}/Spawnfile`]) as Project;
  const nested = project.kind === 'team';
  const roles = nested ? project.members.map(role) : [role({ id, runtime: project.runtime })];
  return { id, nested, roles };
});
// Keep each authored reference together when a line wraps on a phone.
const teamLines = source.split(/^networks:/m, 1)[0].trimEnd().split('\n').map((line) => {
  const match = /^(.*?\bid:\s*([\w-]+),\s*)(ref:.*)$/.exec(line);
  const group = groups.find(({ id }) => id === match?.[2]);
  return {
    text: match?.[1] ?? line,
    reference: match?.[3],
    peers: group?.roles.map(({ id }) => id).join(' '),
  };
});

const engineer = load(engineerSource) as {
  name: string;
  runtime: Runtime;
  execution: { model: { primary: { name: string } } };
  workspace: { docs: { system: string } };
};
const agentGroup = {
  id: engineer.name, nested: false, roles: [role({ id: engineer.name, runtime: engineer.runtime })],
};
export const stageExamples = [
  {
    scope: 'team', name: team.name, groups, rooms: team.networks.flatMap((n) => n.rooms),
    lines: teamLines, recipe: teamDockerfile, file: 'research-org', facts: [],
    guide: '/guides/teams/#compile-the-homepage-team', guideLabel: 'Run this team',
  },
  {
    scope: 'agent', name: engineer.name, groups: [agentGroup], rooms: [],
    lines: engineerSource.trimEnd().split('\n').map((text) => ({
      text, reference: undefined, peers: text.startsWith('runtime:') ? engineer.name : undefined,
    })),
    recipe: agentDockerfile, file: 'engineer',
    facts: [['Model', engineer.execution.model.primary.name], ['Instructions', engineer.workspace.docs.system]],
    guide: agentGroup.roles[0].guide.href, guideLabel: 'OpenCode setup',
  },
];
