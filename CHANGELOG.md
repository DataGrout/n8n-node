## [0.3.1] - 2026-08-17

The gateway now serves every account from one global endpoint, and connecting is
a single click.

### Changed
- **Authentication is OAuth2 only.** Create the DataGrout OAuth2 API credential
  and click "Connect my account" — there are no fields to fill in. DataGrout
  registers OAuth clients dynamically, so there is no client ID or secret, and
  n8n refreshes the access token when it expires.
- The node connects to a single global gateway endpoint, so there is nothing
  per-account to configure.
- Requests go through n8n's authenticated HTTP helper rather than setting the
  Authorization header directly, which is what lets n8n refresh the token.

### Removed
- **The API token credential.** Your connected account identifies the server, so
  the credential has no fields at all.

### Migrating from 0.3.0
Create a **DataGrout OAuth2 API** credential, connect your account, and select it
on each DataGrout MCP node in place of the old API credential. Workflow logic
needs no changes.

## [0.3.0] - 2026-08-11

Rebuilt on n8n's native tool primitives so the package qualifies for n8n
verification and Cloud, and **has no runtime dependencies**.
**This is a breaking change** — see Migrating below.

### Changed
- **The node is now a regular action node marked `usableAsTool`**, instead of an
  AI Agent tool sub-node built on LangChain. It has normal Main input and output,
  so it works in plain workflows *and* on an agent's Tool connector, with n8n
  itself doing the tool wrapping.
- **Tools to Allow** replaces the old Tools to Include filter as the permission
  boundary:
  - **All** (default) — any tool on the server can be called
  - **Selected** — a multi-select allow-list; a tool outside it is refused, not
    called, even if the model asks for it
  - **Single Tool** — pin the node to exactly one tool you choose
- Tool results now return the MCP `structuredContent` as node JSON when the
  server provides it, so workflows can map over real fields.

### Added
- **List Tools** operation — returns every allowed tool with its name,
  description, and input schema, so an agent can discover what exists before
  calling anything.
- In **All** and **Selected** modes, **Tool Name** and **Tool Arguments** ship
  pre-filled with `$fromAI()`, so an agent can call any allowed tool with no
  extra setup. **Single Tool** mode exposes nothing for the model to fill.
- A model-supplied tool name is resolved against the server's real tool list
  before anything is called. An unknown name returns the available tools — with
  descriptions — as data, so the model can retry with a correct one instead of
  the call failing. Names are matched even when they carry more or less
  qualification than the server's listing, so both `discovery.plan` and
  `data-grout@1/discovery_perform@1` resolve against however the server lists
  them. Ambiguous names are refused with the list rather than guessed at.
- The tool list is cached for 5 minutes per credential, so validating a name
  costs nothing after the first call.

### Removed
- Runtime dependencies `@langchain/core`, `@n8n/json-schema-to-zod`, and `zod`.
  `n8n-workflow` is a peer dependency and the only import that remains.
- The runtime `StructuredToolkit` resolution that reached into the host n8n
  install via `fs` and `module`. n8n Cloud's sandbox forbids both imports.

### Kept
- Background-task collection: when DataGrout moves a slow request to a
  background task, the node waits and returns the finished result.
- Lean responses: `discovery.plan` / `discovery.perform` get response-shaping
  defaults so large result sets come back as a preview plus a server-side
  reference instead of flooding the context.
- Session reuse: one MCP session per credential, shared across calls, with a
  single fresh retry when the gateway drops it.
- Invalid JSON in **Tool Arguments** reports that directly, and failures in the
  model-driven modes are returned to the model so it can correct itself.

### Migrating from 0.2.0
A 0.2.0 **DataGrout MCP** node was an AI Agent sub-node that exposed every
server tool as a separate agent tool. This version is a regular node with Main
input and output, so **existing 0.2.0 nodes must be replaced, not upgraded**.

Add a **DataGrout MCP** node, leave **Tools to Allow** on **All**, and connect it
to the agent's Tool connector — the model picks the tool at call time. Add a
second node set to **List Tools** so it can discover what is available. Rename
each node after what it does: n8n derives the agent-facing tool name from the
node's name on the canvas.

### Note on exposing every tool as a separate agent tool
n8n only fans a single connection out into N separate agent tools when the value
is an instance of `StructuredToolkit`, a class that lives inside `n8n-core` and
extends LangChain's `BaseToolkit`. Community packages cannot construct it without
importing `n8n-core` or reaching for `fs`/`module` — all disallowed on n8n Cloud.
n8n's own **MCP Client Tool** node does exactly that fan-out and works with
DataGrout today (HTTP Streamable transport + Bearer auth); see the README.

## [0.2.0] - 2026-07-29

The package is now the **DataGrout MCP** AI Agent tool sub-node.

### Changed
- **The node is now an AI Agent tool sub-node** (like the built-in vendor MCP
  entries): it lists the DataGrout server's tools at attach time and exposes
  **each tool as a separate agent tool** — no Operation selector. Configuration
  is just the credential and **Tools to Include** (All / Selected / All Except),
  which acts as the agent's permission boundary.
- Execute step lists the exposed tools (respects the filter).
- Keeps: background-task collection, lean responses, session reuse, timeout.

### Removed
- The List Tools / Execute Tool operations UI (replaced by dynamic tool
  exposure).

### Notes
- This version ships runtime dependencies (`@langchain/core`, `zod`,
  `@n8n/json-schema-to-zod`) and is therefore **not eligible for n8n
  verification / Cloud listing** — self-hosted installs by name
  (`N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`). v0.1.4 remains the last
  verification-eligible release.

## [0.1.4] - 2026-07-29

- Session-retry errors are now wrapped in `NodeApiError` instead of re-thrown
  raw (verification scanner finding).

## [0.1.3] - 2026-07-28

- Repository restructured to the standard single-package layout (credentials/
  and nodes/ at the repo root) so n8n verification vetting can locate the
  credential source. No functional changes.

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
