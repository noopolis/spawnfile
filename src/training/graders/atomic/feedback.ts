import type { AtomicGrader } from './format.js';
import type { AtomicCheckScore, AtomicFeedback } from './types.js';

export function atomicFeedback(checks: AtomicCheckScore[], policy: AtomicGrader['feedback']): AtomicFeedback {
  const failed = checks.filter(check => check.probability === null || check.probability < policy.failure_threshold);
  const feedback: AtomicFeedback = { failed_check_count: failed.length, omitted_failed_checks: failed.length, failed_checks: [] };
  for (const check of failed.slice(0, policy.max_checks)) {
    const entry = { template: check.check.template_id, unit: check.unit.slice(0, policy.max_unit_chars), probability: check.probability };
    feedback.failed_checks.push(entry); feedback.omitted_failed_checks--;
    if (Buffer.byteLength(JSON.stringify(feedback), 'utf8') > policy.max_bytes) {
      feedback.failed_checks.pop(); feedback.omitted_failed_checks++; break;
    }
  }
  return feedback;
}
