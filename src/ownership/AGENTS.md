# Ownership Guide

`src/ownership` contains repository-boundary audits and guard tests. Keep checks deterministic, local to this boundary, and place each implementation beside its tests.

The runtime adapter boundary test discovers built-in adapters from their entry files.
It checks production imports and runtime-name decisions against that ownership.
Keep historical wire identities scoped to their protocol readers.

Sibling package guards distinguish physical registry installs from explicit
source checkouts. Registry packages may contain non-TypeScript source assets;
only actual TypeScript sources activate the source-to-build freshness check.
