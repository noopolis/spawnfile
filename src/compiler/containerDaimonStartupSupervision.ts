/**
 * Root-side supervision for the privileged startup children (engine broker,
 * relay, launcher and auth gateway): bounded readiness waits plus one EXIT
 * trap that terminates every started child if startup fails.
 */
export const DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS = 60;

export const renderDaimonBrokerSocketWait = (
  timeoutSeconds = DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS,
  pollSeconds = 0.1
): string[] => [
  `broker_startup_timeout_seconds=${timeoutSeconds}`,
  `broker_startup_poll_seconds=${pollSeconds}`,
  "broker_startup_started=$SECONDS",
  "broker_process_status_root=/proc",
  "wait_for_broker_socket() {",
  "  socket=$1; child=$2; label=$3",
  "  while [ ! -S \"$socket\" ]; do",
  "    if ! kill -0 \"$child\" 2>/dev/null; then set +e; wait \"$child\"; child_status=$?; set -e; echo \"$label exited before readiness (status $child_status)\" >&2; return 1; fi",
  "    if [ $((SECONDS - broker_startup_started)) -ge \"$broker_startup_timeout_seconds\" ]; then echo \"$label readiness timed out after ${broker_startup_timeout_seconds}s\" >&2; return 1; fi",
  "    sleep \"$broker_startup_poll_seconds\"",
  "  done",
  "}",
  "wait_for_broker_identity() {",
  "  child=$1; expected_uid=$2; expected_caps=$3; label=$4",
  "  while kill -0 \"$child\" 2>/dev/null; do",
  "    status_path=$broker_process_status_root/$child/status",
  "    observed_uid=$(awk '/^Uid:/{print $2}' \"$status_path\" 2>/dev/null || true)",
  "    observed_caps=$(awk '/^CapBnd:/{print $2}' \"$status_path\" 2>/dev/null || true)",
  "    if [ \"$observed_uid\" = \"$expected_uid\" ] && [ \"$observed_caps\" = \"$expected_caps\" ]; then return 0; fi",
  "    if [ $((SECONDS - broker_startup_started)) -ge \"$broker_startup_timeout_seconds\" ]; then echo \"$label identity readiness timed out after ${broker_startup_timeout_seconds}s\" >&2; return 1; fi",
  "    sleep \"$broker_startup_poll_seconds\"",
  "  done",
  "  set +e; wait \"$child\"; child_status=$?; set -e; echo \"$label exited before identity readiness (status $child_status)\" >&2; return 1",
  "}"
];

export const renderDaimonStartupSupervision = (): string[] => [
  ...renderDaimonBrokerSocketWait(),
  "startup_children=()",
  "cleanup_broker_startup() { status=$?; trap - EXIT; for child in \"${startup_children[@]}\"; do kill -TERM \"$child\" 2>/dev/null || true; wait \"$child\" 2>/dev/null || true; done; return \"$status\"; }",
  "trap cleanup_broker_startup EXIT",
  "trap 'exit 143' TERM INT HUP"
];
