// Landing copy shared by the Astro markup and the client scripts.

export const INSTALL_CMD = 'npm install -g spawnfile';

// Paste-into-your-agent prompt: points the agent at the docs instead of scripting steps.
export const SETUP_PROMPT =
  'Set me up with Spawnfile: read https://spawnfile.com/llms.txt and follow the quickstart.';

export const COPIED_TOAST = 'Copied. Paste it into your coding agent.';

// Agent IDs link an authored member, its compiled files and its running instance.
export const STAGE_AGENTS = [
  { id: 'coordinator', runtime: 'daimon', file: 'workspace/AGENTS.md', field: false },
  { id: 'analyst', runtime: 'openclaw', file: 'openclaw.json', field: false },
  { id: 'engineer', runtime: 'opencode', file: 'opencode.json', field: false },
  { id: 'scout', runtime: 'hermes-agent', file: 'config.yaml', field: true },
  { id: 'observer', runtime: 'picoclaw', file: 'config.json', field: true },
];

export const FIELD_MEMBERS = STAGE_AGENTS.filter((agent) => agent.field).map((agent) => agent.id).join(' ');
const allMembers = STAGE_AGENTS.map((agent) => agent.id).join(' ');

export function stageSource(source: string) {
  let group = 'org';
  const rows: { text: string; g: string; line: number }[] = [];
  for (const [i, text] of source.trimEnd().split('\n').entries()) {
    if (text === '    server:') break;
    if (text.startsWith('mode:') || text.startsWith('lead:')) group = 'coordinator';
    if (text === 'members:') group = allMembers;
    if (text === 'networks:') group = 'net';
    const member = /^  - \{ id: ([\w-]+), ref:/.exec(text)?.[1];
    if (member) group = member === 'field-team' ? FIELD_MEMBERS : member;
    rows.push({ text, g: group, line: i + 1 });
  }
  return rows;
}

type OutputRow = { g: string; tree: string; text: string; path?: string };
export const STAGE_OUTPUT: OutputRow[] = [
  { g: 'org', tree: '├─ ', text: 'Dockerfile', path: 'Dockerfile' },
  { g: 'org', tree: '├─ ', text: 'entrypoint.sh', path: 'entrypoint.sh' },
  { g: allMembers, tree: '├─ ', text: 'runtimes/' },
  ...STAGE_AGENTS.flatMap((agent, i) => {
    const last = i === STAGE_AGENTS.length - 1;
    const folder = `${agent.runtime}/agents/${agent.id}/`;
    return [
      { g: agent.id, tree: last ? '│  └─ ' : '│  ├─ ', text: folder },
      { g: agent.id, tree: last ? '│     └─ ' : '│  │  └─ ', text: agent.file, path: `runtimes/${folder}${agent.file}` },
    ];
  }),
  { g: 'net', tree: '└─ ', text: 'container/rootfs/…/moltnet/' },
  { g: 'net', tree: '   ├─ ', text: 'servers/research-org-lab/', path: 'container/rootfs/var/lib/spawnfile/moltnet/servers/research-org-lab' },
  { g: 'net', tree: '   └─ ', text: 'nodes/', path: 'container/rootfs/var/lib/spawnfile/moltnet/nodes' },
];

export const STAGE_IDLE = 'Select a line to follow it across the team.';
export const STAGE_CAPTIONS: Record<string, string> = {
  org: 'The team compiles to <em>one Docker image</em> with a generated entrypoint.',
  coordinator: 'Daimon loads the coordinator’s <em>AGENTS.md</em> and runs its Codex engine.',
  analyst: 'OpenClaw reads the analyst’s gateway settings from <em>openclaw.json</em>.',
  engineer: 'OpenCode starts the engineer’s server from <em>opencode.json</em>.',
  scout: 'Hermes Agent reads the field scout’s <em>config.yaml</em>.',
  observer: 'PicoClaw reads the field observer’s <em>config.json</em>.',
  [FIELD_MEMBERS]: 'The field team compiles to two agents, <em>scout and observer</em>.',
  [allMembers]: 'Each agent gets the files <em>its own harness reads</em>.',
  net: 'The coordinator and analyst join <em>mission-control</em> on the managed Moltnet server.',
};
