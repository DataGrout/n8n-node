## Unreleased

- Long-running DataGrout calls are now handled automatically: when the server
  moves a slow request to a background task, the node waits and returns the
  finished result. Configurable via **Wait for Background Tasks (Ms)**
  (default 120000; set 0 to get the task reference back immediately).
- **Lean Responses** (on by default): large result sets come back as a short
  preview plus a server-side reference you can pass to DataGrout's compute
  tools, instead of thousands of rows flooding the workflow or agent context.
- Faster tool calls: the connection to your DataGrout server is now reused
  between calls instead of re-established every time.
- The **Timeout (Ms)** option is now applied to requests.
- Clearer errors: invalid JSON in **Tool Arguments** says so directly, and
  AI Agent tool errors are returned to the agent so it can correct itself.


## [0.1.2] - 2026-07-28

- Added `repository.directory` so n8n verification vetting can locate the
  credential/node sources in the monorepo.

## [0.1.1] - 2026-07-27

- Republished via GitHub Actions with npm provenance (required for n8n
  verification); no functional changes from 0.1.0.

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
