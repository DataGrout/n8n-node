# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-07-02

### Added
- **DataGrout node** for interacting with a DataGrout remote MCP server via the
  stateless JSON-RPC (`/rpc`) endpoint:
  - Tool: List Tools, Call Tool (searchable tool picker + JSON arguments).
  - Resource: List Resources, Read Resource.
  - Prompt: List Prompts, Get Prompt.
  - Advanced: Raw JSON-RPC (arbitrary method + params).
- **DataGrout API credential** (Bearer access token) with a `tools/list`
  connection test.
- AI Agent support via `usableAsTool`.
