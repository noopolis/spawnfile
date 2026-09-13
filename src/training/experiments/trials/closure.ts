/** Bound the entire drain, including sources that never honor their stop receipt. */
export async function drainObservations(tail: () => Promise<void>, timeoutMs = 2_000): Promise<void> {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    for (let attempt = 0; attempt < 128 && !finished; attempt++) {
      const boundary = tail();
      await boundary;
      if (finished) return;
      if (boundary === tail()) return;
    }
    throw new Error('Native observation source did not quiesce');
  };
  try {
    await Promise.race([drain(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native observation closure deadline exceeded')), timeoutMs);
    })]);
  } finally { finished = true; clearTimeout(timer); }
}
