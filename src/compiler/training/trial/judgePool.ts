import type { TrialWake } from "./boot.js";

type WakeOptions = { deliveryId: string; timeoutMs: number; signal?: AbortSignal };
interface Member {
  readonly container: string;
  wake(text: string, options: WakeOptions): Promise<TrialWake>;
  read(file: string): Promise<string | null>;
  scanCredentials(): Promise<string[]>;
  teardown(): Promise<string | null>;
}

/**
 * Up to `size` warm judges of one identity. A Daimon agent takes one manual wake at a time, so one judge
 * container serializes every judgment of the run; the pool hands each judgment to an idle judge and boots
 * another (`create(index)`) only when every booted one is busy. A judge that fails to boot is dropped, so the
 * next judgment tries again.
 */
export const createJudgePool = (size: number, create: (index: number) => Promise<Member>): Member => {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("judge concurrency must be a positive integer");
  const members: Promise<Member>[] = [];
  const idle: Member[] = [];
  const waiting: { resolve: (member: Member) => void; reject: (error: unknown) => void }[] = [];
  let created = 0, booting = 0;
  const grow = (): void => {
    const index = created++;
    booting++;
    const pending = create(index);
    members.push(pending);
    pending.then((member) => { booting--; release(member); }, (error: unknown) => {
      booting--;
      members.splice(members.indexOf(pending), 1);
      created--;
      // The judgment that asked for this judge fails as an unbooted judge always has; the next one tries again.
      waiting.pop()?.reject(error);
    });
  };
  const release = (member: Member): void => {
    const next = waiting.shift();
    if (next) next.resolve(member); else idle.push(member);
  };
  const acquire = (): Promise<Member> => {
    const ready = idle.pop();
    if (ready) return Promise.resolve(ready);
    const turn = new Promise<Member>((resolve, reject) => waiting.push({ resolve, reject }));
    // A judge already booting will serve the earliest waiter; boot another only for waiters beyond those.
    if (created < size && waiting.length > booting) grow();
    return turn;
  };
  const settled = async (): Promise<Member[]> => (await Promise.all(members.map((member) => member.catch(() => undefined))))
    .filter((member): member is Member => member !== undefined);
  // The first member is booted by the caller and already counted here.
  grow();
  return {
    get container() { return idle[0]?.container ?? ""; },
    read: async (file) => (await settled())[0]?.read(file) ?? null,
    scanCredentials: async () => (await Promise.all((await settled()).map((member) => member.scanCredentials()))).flat(),
    wake: async (text, options) => {
      const member = await acquire();
      try { return await member.wake(text, options); } finally { release(member); }
    },
    teardown: async () => {
      const all = await settled();
      const failures = await Promise.all(all.map((member) => member.teardown().catch(() => null)));
      return failures.find((failure) => failure !== null) ?? null;
    }
  };
};
