# Changelog

## [0.1.1] — unreleased

Re-release of 0.1.0 published through GitHub Actions with npm provenance
(required for n8n verification). No functional changes.

## [0.1.0] — 2026-07-27

First public release.

- **DataGrout node** (`@datagrout/n8n-nodes-datagrout`): List Tools / Execute
  Tool against a DataGrout MCP server, with an All / Selected / All Except tool
  filter enforced on both listing and execution. No runtime dependencies.
- **DataGrout MCP node** (`@datagrout/n8n-nodes-datagrout-mcp`): AI Agent tool
  sub-node that exposes every server tool as a separate agent tool
  (self-hosted only).
- Long-running requests are handled for you: when the server moves a slow
  request to a background task, the node waits and returns the finished
  result. Configurable via **Wait for Background Tasks (Ms)** (default 120000;
  set 0 to get the task reference back immediately).
- **Lean Responses** (on by default): large result sets come back as a short
  preview plus a server-side reference you can pass to DataGrout's compute
  tools, instead of thousands of rows flooding the workflow or agent context.
- The server connection is reused between calls rather than re-established
  every time.
- Clear errors: invalid JSON in **Tool Arguments** says so directly, and AI
  Agent tool errors are returned to the agent so it can correct itself.
