import { count, type CliArguments } from '../arguments.js';

/** Experiment time never becomes a subject, broker turn, or extraction timeout. */
export function commandDeadlines(args: CliArguments) {
  if (args.command !== 'train') {
    const experimentMs = count(args, 'timeout-ms', 180_000, 3_600_000);
    return { experimentMs, trialMs: experimentMs, inferenceMs: experimentMs };
  }
  // Validate both explicit spellings, including an overridden legacy value.
  const legacy = count(args, 'timeout-ms', 43_200_000, 604_800_000);
  const experimentMs = count(args, 'experiment-timeout-ms', legacy, 604_800_000);
  const trialMs = count(args, 'trial-timeout-ms', 3_600_000, 86_400_000);
  return { experimentMs, trialMs, inferenceMs: 1_800_000 };
}
