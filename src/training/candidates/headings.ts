import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';

export interface HeadingSection { ancestry: string[]; depth: number; start: number; end: number }
export function headingSections(content: string): HeadingSection[] {
  const headings = fromMarkdown(content).children.filter(node => node.type === 'heading');
  const stack: { text: string; depth: number }[] = [];
  return headings.map((heading, index) => {
    while (stack.length && stack[stack.length - 1]!.depth >= heading.depth) stack.pop();
    stack.push({ text: toString(heading), depth: heading.depth });
    const next = headings.slice(index + 1).find(node => node.depth <= heading.depth);
    return {
      ancestry: stack.map(parent => parent.text), depth: heading.depth,
      // The heading text stays locked. Its following separator belongs to the editable body.
      start: heading.position!.end.offset!, end: next?.position?.start.offset ?? content.length,
    };
  });
}
export function selectSections(content: string, selectors: string[][]): HeadingSection[] {
  if (!selectors.length) throw new Error('Heading policy requires at least one selector');
  const headings = headingSections(content);
  const selected = selectors.map(selector => {
    if (!selector.length || selector.some(part => typeof part !== 'string' || !part)) throw new Error('Invalid heading ancestry');
    const matches = headings.filter(heading => JSON.stringify(heading.ancestry) === JSON.stringify(selector));
    if (matches.length !== 1) throw new Error(`Missing or ambiguous heading: ${selector.join(' / ')}`);
    return matches[0]!;
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < selected.length; index++) {
    if (selected[index]!.start < selected[index - 1]!.end || selected[index]!.start === selected[index - 1]!.start) {
      throw new Error('Editable heading subtrees overlap');
    }
  }
  return selected;
}
export function lockedSegments(content: string, sections: HeadingSection[]): string[] {
  const result: string[] = [];
  let offset = 0;
  for (const section of sections) {
    result.push(content.slice(offset, section.start));
    offset = section.end;
  }
  result.push(content.slice(offset));
  return result;
}
