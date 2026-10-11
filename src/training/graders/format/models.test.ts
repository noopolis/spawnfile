import { describe, expect, it } from 'vitest';
import { decisionModels, graderForModel, parseGrader } from './index.js';

const base = {
  schema: 'paideia.grader.v1', id: 'writing', golden: 'labels.yaml', calibration: 'calibration.json',
  teachers: [{ id: 'c', provider: 'claude', model: 'teacher-model' }],
  model: { backend: 'teacher', teacher: 'c' }, escalate: { to: 'c', between: [0.3, 0.7] },
  questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }], score: { method: 'weighted' },
};
const local = { id: 'local', backend: 'jev-http', endpoint: 'http://localhost:8000', name: 'small' };
const teacher = { id: 'teacher', backend: 'teacher', teacher: 'c' };
function withModels(models: unknown) { return { ...base, model: undefined, models }; }

describe('decision model authoring', () => {
  it('normalizes legacy model syntax to the equivalent default candidate', () => {
    const legacy = parseGrader(base);
    const explicit = parseGrader(withModels([{ id: 'default', ...base.model }]));
    expect(decisionModels(legacy)).toEqual(decisionModels(explicit));
    expect(decisionModels(legacy)).toEqual([{ id: 'default', backend: 'teacher', teacher: 'c' }]);
    expect(graderForModel(explicit, decisionModels(explicit)[0]!)).toEqual(legacy);
    expect(graderForModel(legacy, decisionModels(legacy)[0]!)).toEqual(legacy);
  });

  it('accepts local and teacher models in authored order and makes isolated model views', () => {
    const authored = [local, teacher, { ...local, id: 'ollama', backend: 'ollama-logprobs' },
      { ...local, id: 'fourth', name: 'large' }];
    const grader = parseGrader(withModels(authored));
    expect(decisionModels(grader)).toEqual(authored);
    const view = graderForModel(grader, decisionModels(grader)[0]!);
    expect(view.model).toEqual({ backend: 'jev-http', endpoint: 'http://localhost:8000', name: 'small' });
    expect(view).not.toHaveProperty('models');
    expect(parseGrader(view)).toEqual(view);
    expect(grader.models).toEqual(authored);
  });

  it('requires exactly one authoring form', () => {
    expect(() => parseGrader({ ...base, models: [teacher] })).toThrow('exactly one of model or models');
    expect(() => parseGrader({ ...base, model: undefined })).toThrow('exactly one of model or models');
  });

  it('rejects empty, oversized and duplicate candidate lists', () => {
    expect(() => parseGrader(withModels([]))).toThrow('models');
    expect(() => parseGrader(withModels(Array.from({ length: 5 }, (_, index) => ({ ...local, id: `m${index}` })))))
      .toThrow('models');
    expect(() => parseGrader(withModels([local, { ...teacher, id: local.id }]))).toThrow('duplicate model id');
  });

  it('validates teacher references and backend-specific fields for every candidate', () => {
    expect(() => parseGrader(withModels([local, { ...teacher, teacher: 'unknown' }]))).toThrow('unknown teacher');
    for (const model of [{ ...local, endpoint: 'not-url' }, { ...local, name: '' }, { ...local, backend: 'unknown' },
      { ...teacher, endpoint: 'http://localhost' }, { ...local, teacher: 'c' }, { backend: 'teacher', teacher: 'c' }]) {
      expect(() => parseGrader(withModels([model]))).toThrow('models.0');
    }
  });

  it.each(['', '__proto__', 'constructor', 'prototype', 'a.__proto__', 'a@constructor', 'line\nbreak', 'line\u2028break'])(
    'rejects unsafe candidate id %j', id => {
      expect(() => parseGrader(withModels([{ ...local, id }]))).toThrow('models.0.id');
    });
});
