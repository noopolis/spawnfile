export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
