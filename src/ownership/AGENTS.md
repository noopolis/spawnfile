# Ownership Guide

`src/ownership` contains repository-boundary audits and guard tests. Keep checks deterministic, local to this boundary, and place each implementation beside its tests.

Sibling package guards distinguish physical registry installs from explicit
source checkouts. Registry packages may contain non-TypeScript source assets;
only actual TypeScript sources activate the source-to-build freshness check.
