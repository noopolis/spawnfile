import { describe, expect, it } from 'vitest';
import type { GrokSlotFreshness, GrokSlotFreshnessStore } from '../child/index.js';
import { prepareNativeSubject } from './subject.js';
import { codexLease, codexSubject, fakeProvisioner, grokLease, grokSubject, trialRoots } from './fixtures.js';
import type { ProvisionedSubject, SubjectProvisionInput } from './types.js';

const minted: GrokSlotFreshness = { expectedNonce: 'd'.repeat(64), minGeneration: 4 };

function store(log: string[] = []): GrokSlotFreshnessStore & { slots: number[] } {
  const slots: number[] = [];
  return { slots, request: async slot => { log.push('request'); slots.push(slot); return { ...minted }; },
    accept: async () => { throw new Error('preparation never accepts'); } };
}

const signal = new AbortController().signal;
const grokOptions = (shape: (input: SubjectProvisionInput) => ProvisionedSubject, log: string[] = []) => {
  const provisioner = fakeProvisioner(shape, log);
  return { provisioner, freshness: store(log), options: { slot: grokLease(), engine: 'grok' as const, agentId: 'agent:writer',
    provisioner, trialRoots: trialRoots(), signal } };
};

describe('prepareNativeSubject', () => {
  it('mints the slot nonce before provisioning and hands it to the provisioner', async () => {
    const log: string[] = [];
    const { provisioner, freshness, options } = grokOptions(input => grokSubject(input.freshness!), log);
    const prepared = await prepareNativeSubject({ ...options, freshness });
    expect(log).toEqual(['request', 'provision']);
    expect(freshness.slots).toEqual([1]);
    expect(provisioner.inputs[0]).toMatchObject({ engine: 'grok', agentId: 'agent:writer', freshness: minted, slot: { index: 1 } });
    expect(prepared.broker).toMatchObject(minted);
    expect(prepared).toEqual(grokSubject(minted));
  });

  it('refuses a broker slot without a freshness store before provisioning', async () => {
    const log: string[] = [];
    const { options } = grokOptions(input => grokSubject(input.freshness!), log);
    await expect(prepareNativeSubject(options)).rejects.toThrow('freshness store');
    expect(log).toEqual([]);
  });

  it('refuses a broker section that launch.v2 would not admit', async () => {
    for (const mutate of [(subject: ProvisionedSubject) => { delete subject.broker; },
      (subject: ProvisionedSubject) => { subject.broker!.denyPaths = []; },
      (subject: ProvisionedSubject) => { (subject.broker as unknown as Record<string, unknown>).credential = '/secret'; },
      (subject: ProvisionedSubject) => { subject.broker!.workerUid = 0; }]) {
      const { freshness, options } = grokOptions(input => { const subject = grokSubject(input.freshness!); mutate(subject); return subject; });
      await expect(prepareNativeSubject({ ...options, freshness })).rejects.toThrow('does not satisfy launch.v2');
    }
  });

  it('refuses a broker that does not echo this trial\'s freshness or a stale generation', async () => {
    for (const freshnessPatch of [{ expectedNonce: 'e'.repeat(64) }, { minGeneration: 3 }]) {
      const { freshness, options } = grokOptions(input => grokSubject({ ...input.freshness!, ...freshnessPatch }));
      await expect(prepareNativeSubject({ ...options, freshness })).rejects.toThrow('echo this trial');
    }
    for (const generation of [3, 4.5]) {
      const { freshness, options } = grokOptions(input => ({ ...grokSubject(input.freshness!), generation }));
      await expect(prepareNativeSubject({ ...options, freshness })).rejects.toThrow('freshness floor');
    }
    const { freshness, options } = grokOptions(input => { const { generation: _, ...rest } = grokSubject(input.freshness!); return rest; });
    await expect(prepareNativeSubject({ ...options, freshness })).resolves.not.toHaveProperty('generation');
  });

  it('refuses a provisioned subject that does not belong to the leased slot', async () => {
    const patches: ((subject: ProvisionedSubject) => void)[] = [
      subject => { subject.broker!.slot = 0; },
      subject => { subject.broker!.workerUid = 2200; },
      subject => { subject.broker!.workerHomePath = '/run/daimon-workers/2200'; },
      subject => { subject.broker!.usageLedgerPath = '/run/training/slots/0/usage/usage.jsonl'; subject.broker!.evaluatorPaths[4]!.path = '/run/training/slots/0/usage'; },
      subject => { subject.broker!.slotPreflightReceipt = '/run/training/slots/0/preflight.json'; },
      subject => { (subject.roots as Record<string, string>).control = '/run/training/slots/0/state'; },
      subject => { subject.workspace = { source: '/run/training/slots/0/workspace', target: '/run/training/slots/0/workspace' };
        (subject.roots as Record<string, string>).workspace = '/run/training/slots/0/workspace'; },
      subject => { (subject.ports as Record<string, number>).control = 20001; },
    ];
    for (const patch of patches) {
      const { freshness, options } = grokOptions(input => { const subject = grokSubject(input.freshness!); patch(subject); return subject; });
      await expect(prepareNativeSubject({ ...options, freshness })).rejects.toThrow(/leased slot|escape the leased/u);
    }
  });

  it('refuses mismatched identity, roots, credentials and extra projections', async () => {
    const cases: [(subject: ProvisionedSubject) => ProvisionedSubject, string][] = [
      [subject => ({ ...subject, agent: { ...subject.agent, id: 'agent:other' } }), 'another agent'],
      [subject => ({ ...subject, roots: { ...subject.roots, home: '/elsewhere' } }), 'roots differ'],
      [subject => ({ ...subject, roots: { ...subject.roots, workspace: '/elsewhere' } }), 'roots differ'],
      [subject => ({ ...subject, projections: [] }), 'exactly one home'],
      [subject => ({ ...subject, credentials: [{ source: '/a', target: '/b' }] }), 'no credentials'],
      [subject => ({ ...subject, projections: [...subject.projections, { role: 'memory', source: '/m', target: '/m' }] }), 'slot runtime home'],
    ];
    for (const [patch, message] of cases) {
      const { freshness, options } = grokOptions(input => patch(grokSubject(input.freshness!)));
      await expect(prepareNativeSubject({ ...options, freshness })).rejects.toThrow(message);
    }
  });

  it('refuses Grok on a shared-uid slot and Codex on a broker slot without minting a nonce', async () => {
    const log: string[] = [];
    const freshness = store(log);
    const grok = fakeProvisioner(input => grokSubject(input.freshness ?? minted), log);
    await expect(prepareNativeSubject({ slot: codexLease(), engine: 'grok', agentId: 'agent:writer', provisioner: grok,
      freshness, trialRoots: trialRoots(), signal })).rejects.toThrow('shared-uid slot cannot host');
    const codex = fakeProvisioner(() => codexSubject(trialRoots()), log);
    await expect(prepareNativeSubject({ slot: grokLease(), engine: 'codex', agentId: 'agent:writer', provisioner: codex,
      freshness, trialRoots: trialRoots(), signal })).rejects.toThrow('Grok subjects only');
    expect(log).toEqual([]);
  });

  it('passes a Codex subject through unchanged with no freshness request', async () => {
    const log: string[] = [];
    const freshness = store(log);
    const subject = codexSubject(trialRoots());
    const provisioner = fakeProvisioner(() => subject, log);
    const prepared = await prepareNativeSubject({ slot: codexLease(), engine: 'codex', agentId: 'agent:writer', provisioner,
      freshness, trialRoots: trialRoots(), signal });
    expect(prepared).toBe(subject);
    expect(prepared).toEqual(codexSubject(trialRoots()));
    expect(log).toEqual(['provision']);
    expect(provisioner.inputs[0]).not.toHaveProperty('freshness');
  });

  it('refuses Codex broker evidence, an escaping control port and a foreign uid', async () => {
    const run = (subject: ProvisionedSubject, slot = codexLease()) => prepareNativeSubject({ slot, engine: 'codex',
      agentId: 'agent:writer', provisioner: fakeProvisioner(() => subject), trialRoots: trialRoots(), signal });
    const subject = codexSubject(trialRoots());
    await expect(run({ ...subject, broker: grokSubject(minted).broker })).rejects.toThrow('no broker slot evidence');
    await expect(run({ ...subject, generation: 1 })).rejects.toThrow('no broker slot evidence');
    await expect(run({ ...subject, ports: { control: 20300 } })).rejects.toThrow('port escapes');
    await expect(run(subject, { ...codexLease(), workerUid: process.geteuid!() + 1 })).rejects.toThrow('shared-uid slot');
  });

  it('stops before provisioning once aborted', async () => {
    const controller = new AbortController();
    const log: string[] = [];
    const freshness: GrokSlotFreshnessStore = { request: async () => { log.push('request'); controller.abort(); return { ...minted }; },
      accept: async () => undefined };
    const { options } = grokOptions(input => grokSubject(input.freshness!), log);
    await expect(prepareNativeSubject({ ...options, freshness, signal: controller.signal })).rejects.toThrow();
    expect(log).toEqual(['request']);
    await expect(prepareNativeSubject({ ...options, freshness, signal: controller.signal })).rejects.toThrow();
    expect(log).toEqual(['request']);
    const late = new AbortController();
    const provisioner = fakeProvisioner(input => { late.abort(); return grokSubject(input.freshness!); });
    await expect(prepareNativeSubject({ ...options, provisioner, freshness: store(), signal: late.signal })).rejects.toThrow();
  });
});
