import { describe, expect, it } from 'vitest';
import type { InferenceProvider } from '../contracts/execution.js';
import { caseOverlaps, changedLines, renderCriticPrompt, reviewCandidate, selectThroughCritic, terms, type CriticInput, type CriticReview } from './index.js';

const baseline = { 'AGENTS.md': '# Reporter\nReport only what the captured rows state.\nFile the narrowest version the rows support.\n' };
const candidate = { 'AGENTS.md': '# Reporter\nReport only what the captured rows state.\nWrite a body of 200 to 400 words.\nA nomination is not an election, a pledge is not a recorded vote.\n' };
const guide = [{ name: 'WRITING.md', text: 'Length follows the captured facts. Two paragraphs is a complete brief.' }];
const trainCases = [
  { id: 'landtag', text: 'Saxony-Anhalt as the result, not the nomination. AfD nominated Tobias Rausch; BSW deputies pledged their votes.' },
  { id: 'strike', text: 'Caribbean strike as jurisdiction. Who authorized it, and on what published showing.' }];
function judge(reply: unknown): CriticInput['judge'] & { prompts: string[]; systems: string[] } {
  const prompts: string[] = [], systems: string[] = [];
  const provider: InferenceProvider = { id: 'p', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate(request) {
      prompts.push(request.prompt); systems.push(request.system ?? '');
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), model: 'm', usage: null, route: 'r' };
    } };
  return { name: 'strong', provider, model: 'm', prompts, systems };
}
const finding = (overrides: Record<string, unknown>) => ({ category: 'contradicts_house_guide', quoted_line: 'Write a body of 200 to 400 words.',
  guide_ref: 'WRITING.md: Length follows the captured facts', why: 'A fixed range rejects complete short briefs.', severity: 'high', ...overrides });

describe('case overlap', () => {
  it('finds added and removed lines', () => {
    expect(changedLines(baseline['AGENTS.md'], candidate['AGENTS.md'])).toEqual({
      added: ['Write a body of 200 to 400 words.', 'A nomination is not an election, a pledge is not a recorded vote.'],
      removed: ['File the narrowest version the rows support.'] });
  });
  it('flags a line lifted from a train case even when it is phrased as a general rule', () => {
    const { added } = changedLines(baseline['AGENTS.md'], candidate['AGENTS.md']);
    expect(caseOverlaps(added, trainCases, [baseline['AGENTS.md'], guide[0]!.text])).toEqual([
      { line: 'A nomination is not an election, a pledge is not a recorded vote.', cases: [{ id: 'landtag', terms: ['nomina', 'pledge'] }] }]);
  });
  it('ignores terms the baseline or the guide already use and respects the minimum', () => {
    expect(caseOverlaps(['Captured facts decide length in Magdeburg.'], [{ id: 'c', text: 'captured facts in Magdeburg' }], ['captured facts'])).toEqual([
      { line: 'Captured facts decide length in Magdeburg.', cases: [{ id: 'c', terms: ['magdeb'] }] }]);
    expect(caseOverlaps(['Captured facts decide length in Magdeburg.'], [{ id: 'c', text: 'captured facts in Magdeburg' }], ['captured facts'], 2)).toEqual([]);
    expect([...terms('Votes voting nominations a the')]).toEqual(['votes', 'voting', 'nomina']);
  });
});

describe('prompt critic', () => {
  it('shows the critic the guide, checks, train case texts, overlap hints and the changed lines', async () => {
    const strong = judge({ summary: 'ok', findings: [] });
    await reviewCandidate({ baseline, candidate, guide, checks: 'length: word-count min 200 max 400', trainCases, judge: strong });
    const prompt = strong.prompts[0]!;
    for (const expected of ['=== HOUSE GUIDE: WRITING.md ===', '=== DECLARED CHECKS (the candidate never sees these) ===\nlength: word-count min 200 max 400',
      '--- case landtag ---\nSaxony-Anhalt as the result, not the nomination.', '--- case strike ---',
      '- "A nomination is not an election, a pledge is not a recorded vote." shares with landtag: nomina, pledge',
      '=== BASELINE PROMPT ===\n--- AGENTS.md ---', '+ Write a body of 200 to 400 words.', '- File the narrowest version the rows support.']) expect(prompt).toContain(expected);
    expect(strong.systems[0]).toContain('List it even when it is phrased as a general rule');
  });
  it('omits what the run does not show', () => {
    const prompt = renderCriticPrompt({ baseline, candidate: baseline, guide, judge: judge({}) }, [], [], []);
    expect(prompt).not.toMatch(/TRAIN CASES|DECLARED CHECKS|OVERLAP HINTS/u);
    expect(prompt).toContain('=== ADDED LINES (in the candidate, not in the baseline) ===\n(none)');
    expect(renderCriticPrompt({ baseline, candidate, guide, trainCases, judge: judge({}) }, [], [], [])).toContain('(none found mechanically; still check every added line)');
  });
  it('blocks on a finding at or above the threshold and records a case-specific finding without blocking below it', async () => {
    const lifted = finding({ category: 'case_specific', quoted_line: 'A nomination is not an election, a pledge is not a recorded vote.', severity: 'medium', case: 'landtag' });
    const blocked = await reviewCandidate({ baseline, candidate, guide, trainCases, judge: judge({ summary: 'quota', findings: [finding({}), lifted] }) });
    expect(blocked).toMatchObject({ verdict: 'block', blockOn: 'high', summary: 'quota', judgeCall: { outcome: 'completed', judge: 'strong' } });
    expect(blocked.findings).toHaveLength(2);
    const listed = await reviewCandidate({ baseline, candidate, guide, trainCases, judge: judge({ summary: 's', findings: [lifted] }) });
    expect(listed).toMatchObject({ verdict: 'pass', findings: [{ category: 'case_specific', case: 'landtag' }] });
    expect(await reviewCandidate({ baseline, candidate, guide, trainCases, blockOn: 'medium', judge: judge({ summary: 's', findings: [lifted] }) })).toMatchObject({ verdict: 'block' });
  });
  it('never takes a verdict from the model and cannot block on a quote that is not in the prompt', async () => {
    expect(await reviewCandidate({ baseline, candidate, guide, judge: judge({ verdict: 'pass', summary: 's', findings: [] }) })).toMatchObject({ verdict: 'error', error: 'critic reply was not a review' });
    const invented = await reviewCandidate({ baseline, candidate, guide, judge: judge({ summary: 's', findings: [finding({ quoted_line: 'Always write 900 words.' })] }) });
    expect(invented).toMatchObject({ verdict: 'pass', findings: [{ unverifiedQuote: true }] });
    const dropped = await reviewCandidate({ baseline, candidate, guide, judge: judge({ summary: 's', findings: [finding({ category: 'dropped_baseline_rule', quoted_line: 'File the  narrowest version the rows support.' })] }) });
    expect(dropped).toMatchObject({ verdict: 'block' });
    expect(dropped.findings[0]).not.toHaveProperty('unverifiedQuote');
  });
  it('is an error, never a pass, when the critic cannot review', async () => {
    expect(await reviewCandidate({ baseline, candidate, guide, judge: judge('not json') })).toMatchObject({ verdict: 'error', error: 'critic reply was not JSON', judgeCall: { outcome: 'invalid-response' } });
    expect(await reviewCandidate({ baseline, candidate, guide, judge: judge(new Error('gateway down')) })).toMatchObject({ verdict: 'error', error: 'critic call failed: gateway down', judgeCall: { outcome: 'generation-error' } });
    const failing = judge({});
    failing.provider.generate = async () => { throw 'plain'; };
    expect(await reviewCandidate({ baseline, candidate: { 'NEW.md': 'x' }, guide, judge: failing })).toMatchObject({ verdict: 'error', error: 'critic call failed: unknown' });
    const controller = new AbortController();
    controller.abort();
    await expect(reviewCandidate({ baseline, candidate, guide, judge: judge({}), signal: controller.signal })).rejects.toThrow();
  });
});

describe('critic gate', () => {
  const review = (verdict: CriticReview['verdict']): CriticReview => ({ verdict, blockOn: 'high', summary: '', findings: [], overlaps: [] });
  const base = { id: 'baseline' }, one = { id: 'one' }, two = { id: 'two' };
  it('keeps the search choice when its review passes', async () => {
    const gate = await selectThroughCritic({ baseline: base, ranked: [{ candidate: one, validationScore: 0.9 }, { candidate: two, validationScore: 0.8 }], review: async () => review('pass') });
    expect(gate).toMatchObject({ selected: one, report: { selectedId: 'one', reviews: [{ candidateId: 'one', selected: true }] } });
    expect(gate.report).not.toHaveProperty('displacedId');
  });
  it('removes a blocked candidate and takes the next that passes', async () => {
    const asked: string[] = [];
    const gate = await selectThroughCritic({ baseline: base, ranked: [{ candidate: one, validationScore: 0.9 }, { candidate: one, validationScore: 0.9 }, { candidate: two, validationScore: 0.8 }, { candidate: base, validationScore: 0.7 }],
      review: async candidate => { asked.push(candidate.id); return review(candidate.id === 'one' ? 'block' : 'pass'); } });
    expect(asked).toEqual(['one', 'two']);
    expect(gate.selected).toBe(two);
    expect(gate.report).toMatchObject({ selectedId: 'two', displacedId: 'one', reviews: [{ candidateId: 'one', selected: false }, { candidateId: 'two', selected: true }] });
  });
  it('falls back to the unreviewed baseline when every candidate is blocked or unreviewable, and stops at the baseline', async () => {
    const asked: string[] = [];
    const gate = await selectThroughCritic({ baseline: base, ranked: [{ candidate: one, validationScore: 0.9 }, { candidate: base, validationScore: 0.8 }, { candidate: two, validationScore: 0.7 }],
      review: async candidate => { asked.push(candidate.id); return review('error'); } });
    expect(asked).toEqual(['one']);
    expect(gate).toMatchObject({ selected: base, report: { selectedId: 'baseline', displacedId: 'one' } });
    expect((await selectThroughCritic({ baseline: base, ranked: [], review: async () => review('pass') })).report).toEqual({ reviews: [], selectedId: 'baseline' });
  });
});
