import { describe, expect, it } from 'vitest';
import { viewerFixture } from './fixture.js';
import { projectViewerData } from './projection.js';
import type { ViewerData } from './types.js';

describe('bounded public viewer projection', () => {
  it('preserves supplied values and strips undeclared raw fields at every level', () => {
    const data = viewerFixture();
    const raw = { ...data, sealedPrompt: 'PRIVATE', trials: data.trials.map((trial) => ({ ...trial,
      rawOutput: 'PRIVATE', checks: trial.checks.map((check) => ({ ...check, rubric: 'PRIVATE' })),
      events: trial.events.map((event) => ({ ...event, args: { secret: 'PRIVATE' } })),
    })) };
    const projected = projectViewerData(raw);
    expect(projected).toEqual(data);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE');
    expect(projected).not.toBe(data);
  });

  it('keeps the judge failure to its closed vocabulary and declared identities', () => {
    const data = viewerFixture();
    const errored = data.trials[0]!.checks[0]!.children[1]!;
    expect(projectViewerData(data).trials[0]!.checks[0]!.children[1]!.judgeFailure)
      .toEqual({ cause: 'provider-error', judge: 'grounding', providerId: 'grok-broker-grant',
        requestedModel: 'grok-4.6', responseModel: 'grok-4.6', responseRoute: 'grok-broker-grant', kind: 'quota', status: 429 });
    // A strict object: an undeclared field is a rejection, not something stripped and shipped.
    const smuggled = viewerFixture();
    Object.assign(smuggled.trials[0]!.checks[0]!.children[1]!.judgeFailure!, { prompt: 'PRIVATE' });
    expect(() => projectViewerData(smuggled)).toThrow();
    for (const patch of [{ cause: 'grant-melted' }, { status: 0 }, { status: 6000 }, { kind: 'vibes' }, { judge: '' }]) {
      const invalid = viewerFixture();
      Object.assign(invalid.trials[0]!.checks[0]!.children[1]!.judgeFailure!, patch);
      expect(() => projectViewerData(invalid), JSON.stringify(patch)).toThrow();
    }
    expect(errored.judgeFailure!.cause).toBe('provider-error');
  });

  it.each([
    (data: ViewerData) => { data.trials[0]!.score = Number.NaN; },
    (data: ViewerData) => { data.trials[0]!.score = 1.1; },
    (data: ViewerData) => { data.usage[0]!.usage!.inputTokens = -1; },
    (data: ViewerData) => { data.cases = Array.from({ length: 1001 }, () => data.cases[0]!); },
  ])('rejects invalid or overlarge data rather than silently truncating: %s', (mutate) => {
    const data = viewerFixture(); mutate(data);
    expect(() => projectViewerData(data)).toThrow();
  });

  it('bounds total bytes and recursive check depth/node counts before rendering', () => {
    const data = viewerFixture();
    data.experiment.title = 'x'.repeat(8 * 1024 * 1024);
    expect(() => projectViewerData(data)).toThrow('8 MiB');
    const deep = viewerFixture();
    let check = deep.trials[0]!.checks[0]!;
    for (let index = 0; index < 26; index += 1) {
      check.children = [{ ...check, children: [] }]; check = check.children[0]!;
    }
    expect(() => projectViewerData(deep)).toThrow('display bounds');
    const wide = viewerFixture();
    wide.trials[0]!.checks = Array.from({ length: 5001 }, () => ({ ...check, children: [] }));
    expect(() => projectViewerData(wide)).toThrow('display bounds');
  });

  it('rejects ambiguous or self-parent candidate identities before drawing lineage', () => {
    const data = viewerFixture();
    data.candidates[1]!.id = data.candidates[0]!.id;
    expect(() => projectViewerData(data)).toThrow('unique without self-parent');
    data.candidates[1]!.id = 'proposal';
    data.candidates[1]!.parentIds = ['proposal'];
    expect(() => projectViewerData(data)).toThrow('unique without self-parent');
  });
});
