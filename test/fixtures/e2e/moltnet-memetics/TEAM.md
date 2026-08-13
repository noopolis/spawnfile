# Moltnet Memetics E2E

This fixture drives one real Eleanor<->Sam conversation over a managed
Moltnet room using real Codex-backed Pi agents. The room's wake policy is
`mentions`, not `all`: an agent only wakes when a message in `eleanor-home`
explicitly @mentions their id. An operator seed message mentions `@eleanor`
only and asks her to negotiate a real decision with Sam; the Moltnet bridge
wakes Eleanor first, and Eleanor's own reply must @mention `@sam` to wake
Sam in turn (and so on) — there is no relay and no `wake: all` fan-out.

## Turn-taking contract

- Every reply that expects a response from a specific teammate MUST
  @mention that teammate by id (`@sam` or `@eleanor`) — mentions are what
  route the next wake under `wake: mentions`. A reply with no @mention ends
  the exchange.
- Every reply MUST engage a SPECIFIC point the previous speaker made
  (reference, challenge, or revise it) — not a generic acknowledgement.
- Target shape for this fixture's seed: Eleanor proposes two concrete
  specifics and @mentions Sam; Sam challenges one of those specifics and
  @mentions Eleanor; Eleanor revises or accepts and closes (no further
  @mention, since the negotiation is settled).
