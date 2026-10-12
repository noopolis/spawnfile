"""Deterministic instruction-change heuristic; never a semantic quality score."""
from collections import Counter
import re
import unicodedata


_DIRECTIVES = frozenset("""
must never always only not before after unless if then first last until once
every each all none no without cannot dont should shall may require required
minimum maximum least most exactly atmost atleast
""".split())
_STOPWORDS = frozenset("""
a an the and or of to in on for with by from as is are be been being this that
these those it its we our you your i my will would can could proposal hypothesis
""".split())


def _inline(text: str) -> str:
    text = re.sub(r"!?\[([^\]]+)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[*_`~]", "", text)


def _canonical(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(re.findall(r"\w+", _inline(text)))


def instruction_units(text: str) -> list[str]:
    """Read headings, list items, table rows, sentences and whole fenced blocks.

    Ordinary soft-wrapped lines form paragraphs; Markdown markers and positions
    do not become instructions. Fence language labels do not affect their body.
    """
    units, paragraph, fence = [], [], []
    fence_marker = None

    def flush():
        joined = _inline(" ".join(paragraph))
        units.extend(re.split(r"(?<=[.!?])\s+", joined))
        paragraph.clear()

    for line in text.splitlines():
        stripped = line.strip()
        marker = re.match(r"^(`{3,}|~{3,})", stripped)
        if fence_marker is not None:
            if marker and marker[1][0] == fence_marker[0] and len(marker[1]) >= len(fence_marker):
                units.append("\n".join(fence))
                fence.clear()
                fence_marker = None
            else:
                fence.append(line)
        elif marker:
            flush()
            fence_marker = marker[1]
        elif not stripped:
            flush()
        elif re.fullmatch(r"[|:\-\s]+", stripped):
            flush()  # Horizontal rules and table separators contain no rule.
        elif re.match(r"^(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|\|)", stripped):
            flush()
            stripped = re.sub(r"^(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)", "", stripped)
            units.extend(re.split(r"(?<=[.!?])\s+", _inline(stripped)))
        else:
            paragraph.append(stripped)
    flush()
    units.append("\n".join(fence))
    return [canonical for unit in units if (canonical := _canonical(unit))]


def _weight(token: str) -> int:
    return 4 if token in _DIRECTIVES or any(char.isdigit() for char in token) else 1


def _similarity(left: str, right: str) -> float:
    a, b = Counter(left.split()), Counter(right.split())
    intersection = sum(count * _weight(token) for token, count in (a & b).items())
    union = sum(count * _weight(token) for token, count in (a | b).items())
    return intersection / union if union else 1.0


def _changed(left: list[str], right: list[str]) -> float:
    a, b = Counter(left), Counter(right)
    shared = a & b
    removed, added = sorted((a - shared).elements()), sorted((b - shared).elements())
    # Highest-similarity pairs first; lexical/index ties are deterministic.
    pairs = sorted((-_similarity(old, new), i, j)
                   for i, old in enumerate(removed) for j, new in enumerate(added))
    old_used, new_used = set(), set()
    change = 0.0
    for negative_similarity, i, j in pairs:
        if i not in old_used and j not in new_used:
            old_used.add(i)
            new_used.add(j)
            change += 1 + negative_similarity
    return change + max(len(removed) - len(old_used), len(added) - len(new_used))


def behavior_change(before: dict[str, str], after: dict[str, str]) -> float:
    """Weighted changed units / maximum unit count, bounded to [0, 1].

    Matching stays within each component: moving rules between resources can
    affect native loading. Exact canonical units match regardless of position.
    Directive and quantity tokens carry four times ordinary token weight.
    """
    left = {key: instruction_units(value) for key, value in before.items()}
    right = {key: instruction_units(value) for key, value in after.items()}
    count = max(sum(map(len, left.values())), sum(map(len, right.values())))
    changed = sum(_changed(left.get(key, []), right.get(key, []))
                  for key in sorted(left.keys() | right.keys()))
    return min(1.0, changed / count) if count else 0.0


def hypothesis_similarity(a: str, b: str) -> float:
    """Content-token Jaccard similarity; punctuation and boilerplate are ignored."""
    left = set(_canonical(a).split()) - _STOPWORDS
    right = set(_canonical(b).split()) - _STOPWORDS
    union = left | right
    return len(left & right) / len(union) if union else 1.0
