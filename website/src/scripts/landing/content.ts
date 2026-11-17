// Landing copy shared by the Astro markup and the client scripts.

export const INSTALL_CMD = 'npm install -g spawnfile';

// Paste-into-your-agent prompt: points the agent at the docs instead of scripting steps.
export const SETUP_PROMPT =
  'Set me up with Spawnfile: read https://spawnfile.com/llms.txt and follow the quickstart.';

export const COPIED_TOAST = 'Copied. Paste it into your coding agent.';

// The hero stage links each line of an example Spawnfile to what it compiles to.
// `g` lists the link groups a row belongs to; rows sharing a group light up together.
// The output tree mirrors a real `spawnfile compile` of this org; keep it that way.
export type StageRow = { g: string; text: string; tree?: string; note?: string };

export const STAGE_SOURCE: StageRow[] = [
  { g: 'org', text: 'kind: team' },
  { g: 'org', text: 'name: research-org' },
  { g: 'lead', text: 'mode: hierarchical' },
  { g: 'lead', text: 'lead: coordinator' },
  { g: 'coordinator analyst field', text: 'members:' },
  { g: 'coordinator', text: '  - { id: coordinator, ref: ./agents/coordinator }' },
  { g: 'analyst', text: '  - { id: analyst,     ref: ./agents/analyst }' },
  { g: 'field', text: '  - { id: field-team,  ref: ./teams/field }' },
  { g: 'net', text: 'networks:' },
  { g: 'net', text: '  - id: local_lab' },
  { g: 'net', text: '    provider: moltnet' },
  { g: 'net', text: '    rooms: [{ id: mission-control }]' },
];

export const STAGE_OUTPUT: StageRow[] = [
  { g: 'org', tree: '├─ ', text: 'Dockerfile' },
  { g: 'org', tree: '├─ ', text: 'entrypoint.sh' },
  { g: 'coordinator analyst field', tree: '├─ ', text: '', note: 'runtimes/' },
  { g: 'coordinator lead', tree: '│  ├─ ', text: 'daimon/agents/coordinator/' },
  { g: 'coordinator lead', tree: '│  │  └─ ', text: 'workspace/AGENTS.md' },
  { g: 'analyst', tree: '│  ├─ ', text: 'picoclaw/agents/analyst/' },
  { g: 'analyst', tree: '│  │  └─ ', text: 'config.json' },
  { g: 'field', tree: '│  └─ ', text: 'openclaw/agents/' },
  { g: 'field lead', tree: '│     ├─ ', text: 'field-representative/' },
  { g: 'field', tree: '│     └─ ', text: 'field-observer/' },
  { g: 'net', tree: '└─ ', text: '', note: 'container/rootfs/…/moltnet/' },
  { g: 'net', tree: '   ├─ ', text: 'servers/research-org-local_lab/' },
  { g: 'net', tree: '   └─ ', text: 'nodes/', note: '  one per member' },
];

export const STAGE_IDLE = 'Hover a line to see what it becomes.';

// Keyed by a row's full `g`, then by its first group.
export const STAGE_CAPTIONS: Record<string, string> = {
  org: 'One org becomes <em>one image</em>. The Dockerfile and entrypoint are generated.',
  lead: 'The coordinator leads. Each nested team answers through <em>its own lead</em>.',
  coordinator: 'An agent becomes a <em>native config and workspace</em> for its harness.',
  analyst: 'An agent becomes a <em>native config and workspace</em> for its harness.',
  field: 'A nested team compiles down to <em>its agents</em>.',
  net: 'The room becomes a <em>managed Moltnet server</em> in the same container.',
  'coordinator analyst field': 'Every member becomes a <em>workspace its harness reads natively</em>.',
};
