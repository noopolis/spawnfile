import { load } from 'js-yaml';
import registrySource from '../../../../runtimes.yaml?raw';

type RegistryEntry = {
  status: string;
  ref: string;
  install?: { tag?: string; version?: string };
};

type HarnessGuide = {
  name: string;
  models: string;
  logins: string;
};

const guides: Record<string, HarnessGuide> = {
  daimon: {
    name: 'Daimon',
    models: 'Codex, Grok, Antigravity',
    logins: 'ChatGPT, SuperGrok or Antigravity',
  },
  openclaw: {
    name: 'OpenClaw',
    models: 'OpenAI, Anthropic, custom and local endpoints',
    logins: 'ChatGPT, Claude or a provider key',
  },
  picoclaw: {
    name: 'PicoClaw',
    models: 'OpenAI, Anthropic, custom and local endpoints',
    logins: 'ChatGPT, Claude or a provider key',
  },
  'hermes-agent': {
    name: 'Hermes Agent',
    models: 'Native providers, custom and local endpoints',
    logins: 'ChatGPT, SuperGrok, Nous Portal, MiniMax or a provider key',
  },
  opencode: {
    name: 'OpenCode',
    models: 'Native providers, custom and local endpoints',
    logins: 'ChatGPT, SuperGrok, GitHub Copilot, OpenCode Go plan key or a provider key',
  },
};

const registry = load(registrySource) as { runtimes: Record<string, RegistryEntry> };
export const harnesses = Object.entries(registry.runtimes)
  .filter(([, runtime]) => runtime.status === 'active')
  .map(([id, runtime]) => {
    const guide = guides[id];
    if (!guide) throw new Error(`The active runtime ${id} needs a website guide.`);
    return { ...guide, id, href: `/runtimes/${id}/`, pin: runtime.install?.tag ?? runtime.install?.version ?? runtime.ref };
  });

export const harnessNames = new Intl.ListFormat('en').format(harnesses.map(({ name }) => name));
