"""Exclude Markdown metadata before measuring instruction changes."""
import re


def instruction_text(text: str) -> str:
    # Only a closed document-leading front matter block is metadata.
    text = re.sub(r'\A\ufeff?---[^\S\n]*\n.*?\n(?:---|\.\.\.)[^\S\n]*(?:\n|$)',
                  '', text, count=1, flags=re.DOTALL)
    output, fence, comment = [], None, False
    for line in text.splitlines(keepends=True):
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence is not None:
            output.append(line)
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                fence = None
            continue
        if marker and not comment:
            fence = marker[1]
            output.append(line)
            continue
        had_comment = comment or '<!--' in line
        visible = ''
        while line:
            if comment:
                end = line.find('-->')
                if end < 0:
                    line = ''
                else:
                    line, comment = line[end + 3:], False
            else:
                start = line.find('<!--')
                if start < 0:
                    visible += line
                    line = ''
                else:
                    visible += line[:start]
                    line, comment = line[start + 4:], True
        # A metadata-only line must not create a paragraph or heading boundary.
        if had_comment and not visible.strip():
            if visible.endswith('\n') and output and not output[-1].endswith('\n'):
                output.append('\n')
            continue
        # Reference definitions carry link metadata, not instructions.
        if re.match(r'^ {0,3}\[[^\]\n]+\]:\s*\S', visible):
            continue
        output.append(visible)
    return ''.join(output)
