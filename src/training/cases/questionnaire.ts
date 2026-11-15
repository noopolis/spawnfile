import type { CheckNode } from '../contracts/dataset.js';
import { BankError, bankContexts, bankJudges, parseBank } from '../questionnaire/index.js';
import type { PlanResolution } from './plans.js';
import { fail, object } from './validation.js';

/** A bank is validated where it is frozen: every judge it names must be a declared route, every context bound. */
export function resolveQuestionnaire(node: CheckNode, context: PlanResolution, source: string, location: string): void {
  let bank;
  try { bank = parseBank(source); }
  catch (error) { return fail(`${location}.bank`, error instanceof BankError ? error.message : 'unreadable questionnaire bank'); }
  const bound = object(node.context ?? {}, `${location}.context`);
  for (const name of bankContexts(bank)) if (!Object.hasOwn(bound, name)) fail(location, `unbound questionnaire context ${name}`);
  for (const name of Object.keys(bound)) if (!bankContexts(bank).includes(name)) fail(location, `unknown questionnaire context ${name}`);
  for (const name of bankJudges(bank)) {
    const route = context.registry.judges?.[name];
    if (!route) fail(location, `unresolved judge route ${name}`);
    context.versions[`judge:${name}`] = route.version;
  }
}
