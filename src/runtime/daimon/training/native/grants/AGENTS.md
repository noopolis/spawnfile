# Daimon inference grants

Owns the binding from Paideia's runtime-neutral `GrokInferenceGrantAuthority`
(`src/contracts/inference-grants.ts`) to Daimon's public `/runtime` grant client:
`EngineBrokerControlClient` request/release over the container-supplied control
socket and `renderGrokInferenceClientConfig` bytes. Never reimplement broker
framing, guess the socket path, read the broker credential or inference ledger.

`pins.ts` is Paideia's independent pin of Daimon's inference client contract
(client model id, env key, proxy URL, live-grant cap and the per model/effort
config sha256). Loading fails closed when the socket is absent, Daimon lacks the
exports, or the installed manifest differs from the pin; the provider then
refuses to render a GROK_HOME whose bytes do not hash to the pin. A Daimon
change to the client config must update the pin here in the same change.

`daimon-contract.test.ts` checks the pin against the installed Daimon (skipped
when the optional peer is absent). Local verification: `npx vitest run
src/adapters/daimon-native/grants src/inference/grok`.
