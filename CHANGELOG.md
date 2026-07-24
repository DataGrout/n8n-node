## Unreleased

- **Transparent background-task collection**: calls that detach (`status: "detached"`)
  are collected via `tasks.wait` automatically; new `Wait for Background Tasks (Ms)`
  option (default 120000, 0 disables) on the DataGrout node.
- **Lean response defaults**: `discovery.plan`/`discovery.guide` get `lean`+`head`,
  `discovery.perform` gets `head`, unless the caller sets them; `Lean Responses`
  option (default on) on the DataGrout node.
- **MCP session reuse**: one cached session per credential (10 min TTL) with a
  single fresh-session retry on failure — was 3 round-trips per call.
- **Timeout option now honored** (was declared but unused).
- Agent tool errors are returned as text to the agent (self-correction) instead
  of aborting the agent step (`n8n-nodes-datagrout-mcp`).
- Friendly error for malformed Tool Arguments JSON.
- Build hygiene: pinned `@n8n/node-cli` / `n8n-workflow` (floating `*` had
  desynced the lockfiles and broken `npm ci`); single root lockfile is now
  canonical (per-package locks removed); CI/publish install once at the root
  with `--ignore-scripts`.

# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-07-22

Initial release.

### `@datagrout/n8n-nodes-datagrout` (verified track, zero dependencies)

- **DataGrout node** — a programmatic MCP client over Streamable HTTP
  (`initialize` → session → `tools/list` / `tools/call`, JSON and SSE responses),
  with operations **List Tools** and **Execute Tool**, and a tool filter
  (**All / Selected / All Except**) enforced on both listing and execution.
  `usableAsTool: true`, so it can also be attached to an AI Agent as one tool.
- **DataGrout API credential** — API Token (Bearer) + Server ID + Gateway Base
  URL, with an MCP `initialize` credential test.
- Zero runtime dependencies, `n8n.strict: true`, strict ESLint clean —
  eligible for n8n verification.

### `@datagrout/n8n-nodes-datagrout-mcp` (self-hosted, agent tool sub-node)

- **DataGrout MCP node** — the "Atlassian MCP"-style experience: a `supplyData`
  tool sub-node that lists the server's MCP tools at attach time and exposes
  **each tool as a separate AI Agent tool** (name, description, and JSON-Schema →
  Zod input schema per tool). No operation selector — just the credential and a
  **Tools to Include** filter (All / Selected / All Except), which acts as the
  agent's permission boundary. Also implements `execute()` so the node's
  Execute step lists the exposed tools.
- Shares the `dataGroutApi` credential with the main package.
- Ships runtime dependencies (`@langchain/core`, `zod`, `@n8n/json-schema-to-zod`)
  pinned to the target n8n release — intentionally **not** verification-eligible;
  for self-hosted instances (`N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`).
