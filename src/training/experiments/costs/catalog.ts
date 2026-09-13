import type { ModelPrice } from './types.js';

/** Offline snapshot; refreshing rates is an explicit source change, never a dry-run side effect. */
export const standardPrices: readonly ModelPrice[] = [
  {
    model: 'gpt-5.5', vendor: 'openai', currency: 'USD',
    perMillion: { input: 5, cacheRead: 0.5, output: 30 },
    source: 'https://developers.openai.com/api/docs/models/gpt-5.5', checkedAt: '2026-09-13',
    scope: 'Standard global text-token pricing; excludes tools, regional uplifts and priority tiers.',
    longContext: { aboveInputTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  {
    model: 'gpt-5.5-2026-04-23', vendor: 'openai', currency: 'USD',
    perMillion: { input: 5, cacheRead: 0.5, output: 30 },
    source: 'https://developers.openai.com/api/docs/models/gpt-5.5', checkedAt: '2026-09-13',
    scope: 'Standard global text-token pricing; excludes tools, regional uplifts and priority tiers.',
    longContext: { aboveInputTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  {
    model: 'claude-fable-5-1', vendor: 'anthropic', currency: 'USD',
    perMillion: { input: 10, cacheRead: 0.25, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    source: 'https://platform.claude.com/docs/en/about-claude/pricing', checkedAt: '2026-09-13',
    scope: 'Standard global text-token pricing; excludes tools, residency and fast-mode surcharges.',
  },
];
