export const safeSegment = (value: string): string => {
  if (!value || value === "." || value === ".." || /[/\\\0]/u.test(value)) throw new Error(`Unsafe history identity ${JSON.stringify(value)}`);
  return value;
};
