import { createDaimonAdapter } from './legacy/index.js';
import { loadDaimonGrokGrantAuthority } from './native/grants/index.js';
import type { SubjectAdapterRegistration } from '../../../training/subjects/index.js';

export const daimonTrainingSubject: SubjectAdapterRegistration = {
  create: createDaimonAdapter,
  hostInference: { grantAuthority: loadDaimonGrokGrantAuthority },
};
