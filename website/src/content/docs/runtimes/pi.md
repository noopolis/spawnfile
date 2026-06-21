---
title: Pi
description: Compatibility notes for the legacy Pi runtime name.
---

`runtime: pi` is kept as a compatibility alias for the generated Daimon runtime
path. New Spawnfiles should use [`runtime: daimon`](/runtimes/daimon/).

Spawnfile still uses Pi packages under the hood because Daimon is currently
backed by Pi's SDK and model/auth storage. The supported behavior is documented
on the Daimon runtime page.
