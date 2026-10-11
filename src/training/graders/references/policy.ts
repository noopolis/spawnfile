import { stableDigest } from '../format/index.js';
import type { CouncilOutput, GrokWindow, TeacherAnswer } from './types.js';

export const defaultGrokWindow: GrokWindow = { start: '20:30', end: '06:30', timeZone: 'Europe/Berlin' };
export function grokWindowOpen(now: Date, window: GrokWindow = defaultGrokWindow): boolean {
  const minutes = (value: string) => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Invalid Grok window time');
    const [hours, mins] = value.split(':').map(Number);
    return hours! * 60 + mins!;
  };
  const start = minutes(window.start), end = minutes(window.end);
  if (window.timeZone !== undefined && window.timeZone !== 'Europe/Berlin') throw new Error('Grok window timezone must be Europe/Berlin');
  if (start === end) throw new Error('Grok window must have distinct boundaries');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: window.timeZone ?? 'Europe/Berlin',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const current = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  const outer = current >= 20 * 60 + 30 || current < 6 * 60 + 30;
  return outer && (start < end ? current >= start && current < end : current >= start || current < end);
}

/** Confidence is supported answer mass; unassigned mass remains explicitly unknown. */
export function averageAnswers(options: string[], answers: TeacherAnswer[]) {
  const distribution = Object.fromEntries(options.map(option => [option, 0]));
  for (const vote of answers) {
    if (Object.hasOwn(distribution, vote.answer)) distribution[vote.answer]! += (vote.p ?? 1) / answers.length;
  }
  return { distribution, unknown_mass: Math.max(0, 1 - Object.values(distribution).reduce((sum, p) => sum + p, 0)) };
}

export function councilContentDigest(output: Omit<CouncilOutput, 'digest'>): string { return stableDigest(output); }
export function reusableCouncil(output: CouncilOutput, identity: string): boolean {
  const { digest, ...content } = output;
  return output.complete === true && output.identity === identity && digest === councilContentDigest(content);
}
