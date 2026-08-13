# Ownership Guide

`src/ownership` contains repository-boundary audits and guard tests. Keep checks deterministic, local to this boundary, and place each implementation beside its tests.

`simfileRunOperatorInputs.ts` owns the strict nonsecret operator request,
resolved run-root projection, and correlated public receipt for the composed
Simfile-run boundary. Private target configuration remains stdin-only and is
absent from all three values; this runtime-specific contract must not enter the
generic target deployment modules.

Sibling package guards distinguish physical registry installs from explicit
source checkouts. Registry packages may contain non-TypeScript source assets;
only actual TypeScript sources activate the source-to-build freshness check.
