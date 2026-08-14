# Mixed Runtime Org

This fixture verifies that OpenClaw, PicoClaw, and the Spawnfile Daimon runtime can
coexist in one compiled organization and share a Moltnet room.

The memory fixture includes a team bank shared by OpenClaw, PicoClaw, and
Daimon, plus a Daimon-local bank. OpenClaw and PicoClaw receive Mneme through
generated MCP servers; Daimon receives direct in-process Mneme wiring.
