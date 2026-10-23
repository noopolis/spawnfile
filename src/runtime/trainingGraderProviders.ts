import { createClaudeInference } from '../training/index.js';
import { configureGraderProviders, type GraderProviderRegistry, type GraderTeacher,
  type ProviderAvailabilityWindow } from '../training/contracts/index.js';
import { CONTAINED_TEACHER_POLICY, EMPTY_TOOLS_TEACHER_POLICY } from '../shared/trainingLegacy/index.js';
import { createCodexInference } from './codex-exec/training/providers/codex-subscription/index.js';
import { createGrokInference } from './daimon/training/providers/grok-subscription/index.js';

export const defaultGrokWindow: ProviderAvailabilityWindow = { start: '20:30', end: '06:30', timeZone: 'Europe/Berlin' };
export function grokWindowOpen(now: Date, window: ProviderAvailabilityWindow = defaultGrokWindow): boolean {
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
function atomicConfig(teacher: GraderTeacher): void {
  if (teacher.effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(teacher.effort)) throw new Error('Unsupported extractor effort');
}
const registry: GraderProviderRegistry = {
  providers: [
    { id: 'claude', inferenceProviderId: 'claude-subscription', decisionTools: 'disabled', teacherPolicy: EMPTY_TOOLS_TEACHER_POLICY,
      decompositionExtractor: true, atomicExtractor: false, validateAtomicConfig: atomicConfig,
      create(teacher, timeoutMs) {
        if (teacher.effort !== undefined) throw new Error('Claude teacher effort is unsupported');
        return createClaudeInference({ timeoutMs });
      } },
    { id: 'codex', inferenceProviderId: 'codex-subscription', decisionTools: 'contained', teacherPolicy: CONTAINED_TEACHER_POLICY,
      decompositionExtractor: true, atomicExtractor: true, validateAtomicConfig: atomicConfig,
      create: (teacher, timeoutMs) => createCodexInference({ timeoutMs, reasoningEffort: teacher.effort }) },
    { id: 'grok', inferenceProviderId: 'grok-subscription', decisionTools: 'disabled', teacherPolicy: EMPTY_TOOLS_TEACHER_POLICY,
      decompositionExtractor: false, atomicExtractor: false, validateAtomicConfig: atomicConfig,
      create(teacher, timeoutMs) {
        const effort = teacher.effort;
        if (effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('Unsupported Grok teacher effort');
        return createGrokInference({ timeoutMs, reasoningEffort: effort as 'low' | 'medium' | 'high' | 'xhigh' | undefined });
      } },
  ],
  council: { requiredProviders: ['codex', 'claude'], requiredMessage: 'Council requires independent codex and claude teachers',
    defaultWindow: defaultGrokWindow, windowOpen: grokWindowOpen, limitedProvider: 'grok',
    outsideWindow: window => `Outside Grok window ${window.start}-${window.end} ${window.timeZone ?? 'Europe/Berlin'}`,
    closedWindow: phase => `Grok window closed before ${phase} call`, extractorMessage: 'Select one or two Codex/Claude extractors' },
};
export function installBuiltinGraderProviders(): void { configureGraderProviders(registry); }
