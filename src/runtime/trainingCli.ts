#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch as launchTraining, type CliDependencies } from '../training/cli/index.js';
import { trainingDependencies } from './trainingSubjects.js';

export { main } from './trainingSubjects.js';

/** Executable project integrations receive the same subject registry as host calls. */
export async function launch(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<void> {
  await launchTraining(argv, await trainingDependencies(dependencies));
}

// Stdin and embedding hosts may set argv[1] to a label rather than an existing file.
function isExecutableEntry(): boolean {
  try {
    return Boolean(process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url);
  } catch { return false; }
}

// Importing the host composition must not launch a second CLI or install signal handlers.
if (isExecutableEntry()) await launch();
