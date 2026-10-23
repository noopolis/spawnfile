import { expect, it } from 'vitest';
import { createCalibrationIdentity, parseGrader, type CalibrationFile } from '../../graders/index.js';
import { calibrationReport, type QuestionDiagnostics } from './report.js';

it('renders legacy default selection and absent evidence without inventing candidate metrics', () => {
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'g.yaml', calibration: 'c.json',
    teachers: [{ id: 't', provider: 'claude', model: 'm' }], model: { backend: 'teacher', teacher: 't' },
    escalate: { to: 't', between: [0.4, 0.6] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }], score: { method: 'weighted' } });
  const file: CalibrationFile = { schema: 'paideia.grader-calibration.v1',
    identity: createCalibrationIdentity(grader, { backendModel: 'm', golden: 'a'.repeat(64), promptTemplateVersion: 'v', seed: 's', exclusions: [] }),
    questions: { q: { status: 'insufficient-evidence', failures: ['no observations'],
      metrics: { groups: 0, instances: 0, good: 0, bad: 0, baseRate: 0 } } } };
  const diagnostics: Record<string, QuestionDiagnostics> = { q: { missingRate: 1, boundedRate: 0,
    sourceMix: { human: 0, editor: 0, consensus: 0, 'single-teacher': 0 },
    permutation: { compared: 0, missing: 16, flipRate: null } } };
  const report = calibrationReport(file, diagnostics, { excluded: 0, disputed: 0, unavailable: 1 });
  expect(report).toContain('Selected model: default');
  expect(report).not.toContain('- Candidate');
  expect(report).toContain('decision flip rate —');
  expect(report).toContain('cascade accuracy: —.');
  expect(report).not.toContain('Teacher independent held-out accuracy:');
});
