# Mixed Runtime Org

This fixture verifies that OpenClaw, PicoClaw, and the legacy generated-Pi runtime can
coexist in one compiled organization and share a Moltnet room.

The memory fixture includes a team bank shared by OpenClaw, PicoClaw, and
Pi, plus a Pi-local bank. OpenClaw and PicoClaw receive Mneme through
generated MCP servers; Pi receives direct in-process Mneme wiring.
