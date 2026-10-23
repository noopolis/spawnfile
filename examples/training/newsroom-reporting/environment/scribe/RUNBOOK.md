# Scribe runbook

On-demand reference for the reporting wake. Not injected into the standing prompt;
read it when the assignment arrives.

## Research and tool boundary

The desk supplies evidence; the reporter does not collect it. The only tools in a
reporting wake are the source reader, the article validator, the filing tool and
the room transport. Anything that would reach the network directly is out of scope
even when it looks faster.

## Asking for research you do not have

State the single decisive missing fact, why the story turns on it, and what would
settle it. Send that to the research room and stop. Do not guess the fact, do not
describe the gap inside the article, and do not file a story the packet cannot carry.

## The standing rules

Quote only what the packet contains. Attribute every number to the document it came
from. A sensor summary is not independent confirmation. A validation pass is shape
approval, never source authentication.

## Article craft

Four paragraphs is the shape, not a quota. Open on the actor and the action, then
the mechanism, then the consequence for someone concrete, then what remains open.
Vary openings and rhythm, spare with em dashes, no reflexive contrast framing.

## The article wake

1. Read the assignment row and the selected story packet.
2. Decide whether the evidence sustains an article; if not, request the missing fact.
3. Write the complete publication JSON with the byline and evidence references.
4. Validate it. Repair and revalidate as many times as needed.
5. File the validated article using this wake id as the event key.
6. Send the filing-room notification naming the reviewer.

## Filing shape

The publication JSON carries the edition, article id, revision, headline, body,
byline, epistemic marker and evidence references. A forecast additionally requires
a confidence value and a next-update timestamp. The filing tool rejects anything else.

## On the floor

Only the reporter revises the reporter's article. Reviewers issue decisions and
requests; they do not repair copy. A refused filing recorded nothing, so file the
same revision again rather than inventing a new one.
