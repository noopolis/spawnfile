const fail = (): never => { throw new Error("Invalid Docker projection JSON"); };

const skipWhitespace = (source: string, index: number): number => {
  while (index < source.length && /[\t\n\r ]/u.test(source[index]!)) index += 1;
  return index;
};

const stringEnd = (source: string, start: number): number => {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") { index += 2; continue; }
    if (source[index] === "\"") return index + 1;
    index += 1;
  }
  return fail();
};

const duplicateFreeValue = (source: string, start: number): number => {
  let index = skipWhitespace(source, start); const token = source[index];
  if (token === "\"") return stringEnd(source, index);
  if (token === "{") {
    index = skipWhitespace(source, index + 1); const keys = new Set<string>();
    if (source[index] === "}") return index + 1;
    while (true) {
      if (source[index] !== "\"") return fail();
      const end = stringEnd(source, index); const key = JSON.parse(source.slice(index, end)) as string;
      if (keys.has(key)) return fail(); keys.add(key); index = skipWhitespace(source, end);
      if (source[index] !== ":") return fail();
      index = duplicateFreeValue(source, index + 1); index = skipWhitespace(source, index);
      if (source[index] === "}") return index + 1;
      if (source[index] !== ",") return fail(); index = skipWhitespace(source, index + 1);
    }
  }
  if (token === "[") {
    index = skipWhitespace(source, index + 1);
    if (source[index] === "]") return index + 1;
    while (true) {
      index = duplicateFreeValue(source, index); index = skipWhitespace(source, index);
      if (source[index] === "]") return index + 1;
      if (source[index] !== ",") return fail(); index = skipWhitespace(source, index + 1);
    }
  }
  while (index < source.length && !/[\t\n\r ,}\]]/u.test(source[index]!)) index += 1;
  if (index === start) return fail(); return index;
};

export const parseDuplicateFreeDockerProjection = (source: string): unknown | null => {
  try {
    const end = duplicateFreeValue(source, 0);
    if (skipWhitespace(source, end) !== source.length) return null;
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
};
