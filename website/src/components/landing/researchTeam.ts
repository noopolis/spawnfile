import { load } from 'js-yaml';
import source from '../../../../examples/research-org/Spawnfile?raw';
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
export const groups = team.members.map(({ id, ref }) => {
  const directory = ref.replace(/^\.\//, '');
  const project = load(projects[`../../../../examples/research-org/${directory}/Spawnfile`]) as Project;
  const nested = project.kind === 'team';
  const roles = nested ? project.members.map(role) : [role({ id, runtime: project.runtime })];
  return { id, nested, roles };
});
export const teamName = team.name;
export const roles = groups.flatMap((group) => group.roles);
export const rooms = team.networks.flatMap((network) => network.rooms);

// Keep each authored reference together when a line wraps on a phone.
export const excerpt = source.split(/^networks:/m, 1)[0].trimEnd().split('\n').map((line) => {
  const match = /^(.*?\bid:\s*([\w-]+),\s*)(ref:.*)$/.exec(line);
  const group = groups.find(({ id }) => id === match?.[2]);
  return {
    text: match?.[1] ?? line,
    reference: match?.[3],
    peers: group?.roles.map(({ id }) => id).join(' '),
  };
});
