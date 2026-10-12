# Bounded native processes

Owns shell-free child launch, bounded stdout/stderr, ordered async delivery and
scoped process-group cancellation. It never interprets vendor JSON or chooses auth.

- Callback failures interrupt execution and propagate; no silent event loss.
- Quiescence is scoped to the observed group; escaped descendants/remote jobs remain unknown.
- Leader reap ends signaling authority, not bounded read-only group observation.
  Confirm only observed disappearance; a still-visible group at the deadline stays unknown.
- Exercise actual process failure, timeout, callback failure and cancellation in local tests.
- Duplex clients opt into open stdin and strict line terminators. Timeout/stop
  abort callbacks; natural close allows a bounded drain before aborting unfinished work.

`callbackConcurrency` opts duplex clients into 1..8 callback lanes. The default
remains one ordered lane for native observations. Each callback has its own abort
signal; shutdown waits for all lanes, reporting noncooperative callbacks as errors.
