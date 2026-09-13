# Candidate Resources

Owns immutable instruction, skill and supporting-text snapshots. Public API is
`index.ts`: snapshotCandidate, candidateComponents, deriveCandidate,
validateCandidate, assertOriginalPolicy and materializeCandidate.

- Snapshot only explicit source mappings. Preserve complete original/current UTF-8
  bytes and digests, relative source paths, every native destination and lineage.
  Limits: 256 resources, 1 MiB per source/current file, 16 MiB current aggregate.
- Source aliases must remain inside the selected source root. Duplicate source paths,
  aliased paths and overlapping native destinations fail before installation.
- CommonMark parses heading ancestry and byte-preserving string offsets. A heading
  selector must resolve once, and editable subtrees cannot overlap. Heading text
  and all bytes outside selected bodies stay locked; the following line separator
  belongs to the body. Do not serialize Markdown through an AST formatter.
- Derivation always checks the original baseline policy. Complete source bytes let
  validation reconstruct baseline identity and check locked regions independently;
  recomputing a modified candidate checksum cannot authorize a locked edit.
- candidateComponents exposes only declared editable text. Template rendering is
  not implemented; ordinary Markdown is first-class. No provider calls live here.
- Installation requires an empty trial-owned directory and writes every declared
  destination, then reads bytes back before issuing `installed` receipts. Installed
  is not discovered, loaded or followed; adapters and evaluation own those claims.
- Sources remain unchanged. Native compilation and production deployment stay with
  their owners. Authentication, evidence and evaluator resources are not candidates.
- Source roots and destination parents are host-controlled. This module validates
  contained paths; native sandbox enforcement owns protection from external actors.

Tests live beside source. Exercise changed multi-file components, mirrored native
bytes, unchanged original files, source escapes, heading ambiguity/escapes and forged
locked changes. Run targeted tests/coverage, ESLint and TypeScript during iteration;
retain at least 90% for each executable file and coverage dimension.
