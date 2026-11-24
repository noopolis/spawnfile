import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { parse, serialize, type DefaultTreeAdapterTypes as Html } from 'parse5';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const dist = join(root, 'website/dist');

function* elements(node: Html.Node): Generator<Html.Element> {
  if ('tagName' in node) yield node;
  if ('childNodes' in node) {
    for (const child of node.childNodes) yield* elements(child);
  }
}

const attr = (element: Html.Element, name: string) => element.attrs.find((entry) => entry.name === name)?.value;
const homepage = [...elements(parse(readFileSync(join(dist, 'index.html'), 'utf8')))];

test('every active harness has a linked guide and its published install pin on the homepage', () => {
  const registry = load(readFileSync(join(root, 'runtimes.yaml'), 'utf8')) as {
    runtimes: Record<string, { status: string; ref: string; install: { tag?: string; version?: string } }>;
  };
  const section = homepage.find((element) => attr(element, 'id') === 'harnesses');
  assert.ok(section);
  const rows = [...elements(section)].filter((element) => element.tagName === 'tr');
  const active = Object.entries(registry.runtimes).filter(([, runtime]) => runtime.status === 'active');
  assert.equal(rows.length, active.length + 1);
  for (const [id, { ref, install }] of active) {
    const href = `/runtimes/${id}/`;
    const row = rows.find((row) => [...elements(row)].some((el) => attr(el, 'href') === href));
    assert.ok(row && existsSync(join(dist, href, 'index.html')), `missing guide for ${id}`);
    assert.ok(serialize(row).includes(`<code>${install.tag ?? install.version ?? ref}</code>`), `wrong pin for ${id}`);
  }
});

const byClass = (node: Html.Element, name: string) => attr(node, 'class')?.split(' ').includes(name);
const textOf = (node: Html.Node): string => {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
};

function panelElements(panel: string, scope: string) {
  const container = homepage.find((node) => byClass(node, panel));
  assert.ok(container);
  const example = [...elements(container)].find((node) => attr(node, 'data-scope') === scope);
  assert.ok(example);
  return [...elements(example)];
}

function linkedFile(nodes: Html.Element[], label: string) {
  const link = nodes.find((node) => node.tagName === 'a' && textOf(node) === label);
  assert.ok(link);
  const href = attr(link, 'href');
  assert.ok(href);
  return readFileSync(join(dist, href), 'utf8');
}

for (const [scope, project] of [['team', 'examples/research-org'], ['agent', 'examples/research-org/opencode']]) {
  test(`the ${scope} example shows its authored Spawnfile, generated Dockerfile and compiled roster`, (context) => {
    const file = panelElements('demo-file', scope);
    const source = readFileSync(join(root, project, 'Spawnfile'), 'utf8');
    const lines = file.filter((node) => byClass(node, 'source-line')).map((node) =>
      node.childNodes.filter((child) => !('tagName' in child && byClass(child, 'n'))).map(textOf).join(''));
    assert.equal(lines.join('\n'), source.split(/^networks:/m, 1)[0].trimEnd());
    assert.equal(linkedFile(file, 'Full Spawnfile'), source);

    const out = mkdtempSync(join(tmpdir(), 'spawnfile-homepage-'));
    context.after(() => rmSync(out, { recursive: true, force: true }));
    execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'compile', project, '-o', out], {
      cwd: root, env: { ...process.env, SPAWNFILE_MOLTNET_TARGET_ARCH: 'amd64' },
    });
    const report = JSON.parse(readFileSync(join(out, 'spawnfile-report.json'), 'utf8')) as {
      nodes: { kind: string; id: string; runtime: string }[];
      container: { dockerfile: string; moltnet?: { server_plans: { rooms: { id: string; members: string[] }[] }[] } };
    };
    const recipe = readFileSync(join(out, report.container.dockerfile), 'utf8');
    const code = file.find((node) => byClass(node, 'docker-code'));
    assert.ok(code);
    assert.equal(textOf(code), recipe.trimEnd());
    assert.equal(linkedFile(file, 'Full Dockerfile'), recipe);

    const docker = panelElements('demo-docker', scope);
    const roles = docker.filter((node) => byClass(node, 'demo-role'));
    const agents = report.nodes.filter((node) => node.kind === 'agent');
    assert.equal(roles.length, agents.length);
    for (const { id, runtime } of agents) {
      const name = id.slice('agent:'.length);
      const row = roles.find((el) => attr(el, 'data-peer') === name);
      assert.ok(row && attr(row, 'data-runtime') === runtime, `missing ${id}`);
      assert.ok([...elements(row)].some((el) => attr(el, 'href') === `/runtimes/${runtime}/`));
      assert.ok(existsSync(join(out, 'runtimes', runtime, 'agents', name)), `missing workspace for ${id}`);
    }
    if (scope === 'team') {
      const listed = homepage.flatMap((el) => attr(el, 'data-harness') ?? []);
      assert.deepEqual(roles.map((el) => attr(el, 'data-runtime')).sort(), listed.sort());
    }
    const rooms = report.container.moltnet?.server_plans.flatMap((server) => server.rooms) ?? [];
    const shown = docker.filter((node) => byClass(node, 'demo-room')).map((node) => {
      const [name, members] = node.childNodes.filter((child) => 'tagName' in child).map(textOf);
      return { id: name.slice(1), members: members.split(' · ').sort() };
    });
    assert.deepEqual(shown, rooms.map(({ id, members }) => ({ id, members: [...members].sort() })));
  });
}
