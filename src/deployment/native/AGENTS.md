# Native deployment helpers

This folder contains bounded, package-owned native helpers for deployment
syscalls Node does not expose. Helpers accept validated single-component names,
emit one bounded JSON result, and fail closed.

`artifacts/` contains the verified Linux x64 and arm64 package inputs so the
normal Node build stays offline and Docker-free. `copyArtifacts.mjs` verifies
and copies them into `dist`. Only the explicit maintainer `build:native` path
may replace them using the digest-pinned compiler image; CI rebuilds and
syscall-tests both architectures before publication.
