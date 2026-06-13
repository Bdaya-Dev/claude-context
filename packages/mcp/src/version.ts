// Bdaya-Dev fork version of @zilliz/claude-context-mcp.
//
// Base = the upstream npm package version this fork is built on; suffix = the fork
// patch level. Bump FORK_REVISION on every behavioural change to the fork so that
// `get_indexing_status` can report exactly which build is running (useful when the
// MCP server is launched from a local checkout rather than a pinned npm version).
export const UPSTREAM_BASE_VERSION = "0.1.14";
export const FORK_REVISION = "bdaya.1";
export const CLAUDE_CONTEXT_VERSION = `${UPSTREAM_BASE_VERSION}-${FORK_REVISION}`;
