import { moduleBoundaries } from './boundaries.js';
import { directoryStructure, lineTarget } from './structure.js';
export { generatedFilePatterns } from './paths.js';

export const structurePlugin = {
  rules: {
    'line-target': lineTarget,
    'directory-structure': directoryStructure,
    'module-boundaries': moduleBoundaries,
  },
};
