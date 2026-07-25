# DataGrout n8n Nodes

Connect [n8n](https://n8n.io) — and its **AI Agents** — to your
[DataGrout](https://datagrout.ai) MCP servers.

This monorepo ships two community packages:

| Package | What it is | Install target |
|---|---|---|
| [`@datagrout/n8n-nodes-datagrout`](packages/n8n-nodes-datagrout) | **DataGrout** node — MCP client with **List Tools** / **Execute Tool**, an All/Selected/All Except tool filter, and a Bearer credential. Zero runtime dependencies, verification-eligible. | n8n Cloud + self-hosted |
| [`@datagrout/n8n-nodes-datagrout-mcp`](packages/n8n-nodes-datagrout-mcp) | **DataGrout MCP** node — AI Agent tool sub-node that exposes **every server tool as a separate agent tool** (the Atlassian-MCP experience), filtered by All/Selected/All Except. Ships langchain dependencies, so not verification-eligible. | self-hosted only |

Both share the same **DataGrout API** credential (API Token + Server ID +
Gateway Base URL), so configure once and use either package.

## Quick start

1. Install a package from **Settings → Community Nodes**
   (self-hosted agent-tool usage needs `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`).
2. Create a **DataGrout API** credential — token from your DataGrout dashboard,
   Server ID from `gateway.datagrout.ai/servers/{uuid}`.
3. Attach the node to an AI Agent (or use it directly in a workflow).

Zero-config alternative: n8n's built-in **MCP Client Tool** pointed at
`https://gateway.datagrout.ai/servers/{uuid}/mcp` also works. What these packages
add beyond branding and the credential:

- **Background tasks handled for you** — when a slow request moves to a
  background task server-side, the node waits and returns the finished result;
  workflows and agents never deal with task references or polling.
- **Lean responses by default** — a 10,000-row result arrives as a short
  preview plus a server-side reference for DataGrout's compute tools, instead
  of flooding the agent's context.
- **Faster calls** — the server connection is reused between calls.
- **Tool permission filter** — All / Selected / All Except, enforced on both
  listing and execution.

## Development

```bash
cd packages/n8n-nodes-datagrout       # or packages/n8n-nodes-datagrout-mcp
npm install
npm run build
npm run lint                          # verified package only; must stay clean
```

## Releasing

Publishing runs through GitHub Actions with npm provenance (required for n8n
verification). Push a tag named `<package-dir>@<version>`, e.g.:

```bash
git tag n8n-nodes-datagrout@0.1.0 && git push origin n8n-nodes-datagrout@0.1.0
git tag n8n-nodes-datagrout-mcp@0.1.0 && git push origin n8n-nodes-datagrout-mcp@0.1.0
```

One-time setup: on npmjs.com, configure a **Trusted Publisher** for each package
(repo `DataGrout/n8n-node`, workflow `publish.yml`) — or store a granular
`NPM_TOKEN` in the repo's Actions secrets as fallback.

## License

[MIT](LICENSE)
