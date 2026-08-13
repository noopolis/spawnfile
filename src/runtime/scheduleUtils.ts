export const isEveryScheduleValue = (value: string): boolean =>
  /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u.test(value.trim());

export const parseEveryScheduleMs = (value: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u.exec(value.trim());
  if (!match) {
    return null;
  }

  const multipliers: Record<string, number> = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    ms: 1,
    s: 1000
  };

  return Math.max(1, Math.round(Number(match[1]) * multipliers[match[2] ?? "ms"]));
};
