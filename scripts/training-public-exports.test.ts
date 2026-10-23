import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
// Frozen consumer imports at 94eda1d98dce21a71e4caa73f71e60e98f1a72eb,
// including re-exports and deep test imports. Keep the expected names independent
// of the implementation barrels so deleting an export fails this test.
const surface = {
  "core": {
    "values": [
      "parseDatasetYaml",
      "resolveDataset",
      "openExperimentStore",
      "bridgeExecutionIdentity",
      "runTrial",
      "createEvaluationRegistry",
      "evaluatePlan",
      "loadTrialSlots",
      "assertModelRequestAdmission",
      "budgetEvaluatorInference",
      "typeSafeEvaluatorEnvironment",
      "trainingFeedback"
    ],
    "types": [
      "Dataset",
      "EditPolicy",
      "TrialOutcome",
      "TrialSlot",
      "CandidateManifest",
      "NativePreparationContext",
      "TrialPaths",
      "ArtifactSnapshot",
      "TrainingConfiguration"
    ]
  },
  "daimon": {
    "values": [
      "createDaimonNativeAdapter",
      "parseNativeLaunch",
      "createExperimentSlotFreshness",
      "loadNativeLaunch",
      "nativeChildArguments",
      "nativeTrialArtifactsRoot",
      "assertNativeEngineConfig",
      "bindTrialPathsToSlot",
      "nativeSubjectScratch",
      "nativeTrialInputsRoot",
      "verifyNativeWorkerStartup",
      "prepareNativeSubject",
      "verifyExternalSource",
      "nativeChildEnvironment"
    ],
    "types": [
      "NativeLaunch",
      "NativeTurnEvidence",
      "TerminalEvidence",
      "NativeTransportDelivery",
      "ProvisionedSubject",
      "GrokSlotFreshnessStore",
      "NativeSubjectEngine",
      "SubjectProvisioner",
      "NativeChildExternalInputs",
      "NativeAdapterOptions",
      "NativeMount"
    ]
  },
  "auth": {
    "values": [
      "stageTrainingAuth"
    ],
    "types": [
      "TrainingAuthProvider"
    ]
  },
  "compiler": {
    "values": [
      "loadTrainingProject",
      "resolveTrainingPlan",
      "lowerTrainingMoments",
      "trainingExecutionSchema",
      "trainingExecutionIdentity",
      "parseTrainingMappedPreparation",
      "TRAINING_FAKETIME_LIBRARY_PATH",
      "compareInstants",
      "inspectMoltnetSqlite",
      "assertTrainingSubjectDeclaration",
      "resolveCompiledAgent",
      "leaseTrainingSubject",
      "createTrainingPlan",
      "materializeTrainingCase",
      "materializedMomentSchema",
      "selectCommitAt",
      "leakCheckSchema",
      "leakCheckTrainingMoment",
      "taskClockSchema",
      "trainingSlotsDocument",
      "lowerTrainingExecution",
      "trainingPreparationSchema",
      "prepareTrainingEvaluators"
    ],
    "types": [
      "TrainingPlan",
      "TrainingSubjectLease",
      "LeaseTrainingSubjectOptions",
      "MaterializedMoment",
      "LeakCheck"
    ]
  },
  "cli": {
    "values": [
      "spawnfileEnvironment",
      "launch",
      "createTrainingInference",
      "CliDatasets",
      "trainingDependencies"
    ],
    "types": [
      "CliExecutionIdentityContext",
      "SpawnfileTrainingContext",
      "TrainingMomentCase",
      "TrainingMomentPreparation",
      "SpawnfileCliIntegration"
    ]
  }
} as const;
const specifier = (name: string): string => name === 'compiler' ? 'spawnfile/training'
  : name === 'auth' ? 'spawnfile/auth' : `spawnfile/training/${name}`;

const run = async (command: string, args: string[], cwd: string) => {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  try {
    return await execute(command, args, { cwd, env, timeout: 180_000, maxBuffer: 10_000_000 });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n'), { cause: error });
  }
};

test('installed tarball exposes every integration value and type through explicit public subpaths', { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spawnfile-training-exports-'));
  try {
    const packed = await run('npm', ['pack', '--json', '--pack-destination', directory], root);
    const packs = JSON.parse(packed.stdout) as { filename: string }[];
    assert.equal(packs.length, 1);
    assert.ok(packs[0]?.filename);
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      join(directory, packs[0].filename)], directory);
    const installed = join(directory, 'node_modules/spawnfile');
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; import: string } | string>;
      dependencies: Record<string, string>;
    };
    for (const name of Object.keys(surface)) {
      const entry = manifest.exports[specifier(name).replace('spawnfile/', './')];
      assert.ok(entry && typeof entry === 'object', `Missing explicit export: ${specifier(name)}`);
      assert.ok(entry.types.endsWith('.d.ts'));
      assert.ok(entry.import.endsWith('.js'));
    }
    assert.equal(manifest.dependencies['@noopolis/daimon'], undefined);
    const probe = `
import assert from 'node:assert/strict';
const before = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
for (const [subpath, names] of ${JSON.stringify(Object.entries(surface).map(([name, api]) => [specifier(name), api.values]))}) {
  const api = await import(subpath);
  for (const name of names) {
    const kind = name === 'TRAINING_FAKETIME_LIBRARY_PATH' ? 'string' : /Schema$/.test(name) ? 'object' : 'function';
    assert.equal(typeof api[name], kind, subpath + ': ' + name);
  }
  if (subpath.startsWith('spawnfile/training/')) assert.deepEqual(Object.keys(api).sort(), names.toSorted());
}
assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), before);
assert.equal(process.exitCode, undefined);
console.log('public-imports-ok');
`;
    await writeFile(join(directory, 'probe.mjs'), probe);
    assert.equal((await run(process.execPath, ['probe.mjs'], directory)).stdout.trim(), 'public-imports-ok');

    const typeProbe = Object.entries(surface).map(([name, api], index) => {
      const types = api.types.map(symbol => `${symbol} as T${index}_${symbol}`);
      const values = api.values.map(symbol => `${symbol} as V${index}_${symbol}`);
      return `import type { ${[...types, ...values].join(', ')} } from '${specifier(name)}';
export type Types${index} = [${api.types.map(symbol => `T${index}_${symbol}`).join(', ')}];
export type Values${index} = [${api.values.map(symbol => `typeof V${index}_${symbol}`).join(', ')}];`;
    }).join('\n');
    await writeFile(join(directory, 'probe.ts'), typeProbe);
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2023', module: 'NodeNext',
        moduleResolution: 'NodeNext', types: ['node'], typeRoots: [join(root, 'node_modules/@types')] },
      files: ['probe.ts'],
    }));
    await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', directory], directory);

    // Mutation check the installed artifact, leaving the working tree untouched.
    const barrel = join(installed, 'dist/training/public.js');
    const original = await readFile(barrel, 'utf8');
    const mutated = original.replace('runTrial, ', '');
    assert.notEqual(mutated, original);
    await writeFile(barrel, mutated);
    await assert.rejects(run(process.execPath, ['probe.mjs'], directory), /spawnfile\/training\/core: runTrial/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
