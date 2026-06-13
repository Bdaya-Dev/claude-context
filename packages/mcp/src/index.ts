#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
// Import our modular components.
// NOTE: anything that transitively imports @zilliz/claude-context-core (which
// eagerly loads the heavy Milvus SDK — ~80s on a cold filesystem cache) is loaded
// LAZILY in ensureInitialized() AFTER the stdio transport connects, so the MCP
// `initialize` handshake never blocks (root cause of MCP error -32001). config.ts
// and snapshot.ts are kept core-free so they remain safe to import statically.
import { createMcpConfig, logConfigurationSummary, showHelpMessage, ContextMcpConfig } from "./config.js";
import { SnapshotManager } from "./snapshot.js";
import type { Context } from "@zilliz/claude-context-core";
import type { SyncManager } from "./sync.js";
import type { ToolHandlers } from "./handlers.js";

class ContextMcpServer {
    private server: Server;
    private config: ContextMcpConfig;
    private snapshotManager: SnapshotManager;
    private context: Context | null = null;
    private syncManager: SyncManager | null = null;
    private toolHandlers: ToolHandlers | null = null;
    private initPromise: Promise<void> | null = null;

    constructor(config: ContextMcpConfig) {
        this.config = config;

        // Initialize MCP server (lightweight — no core/Milvus imports here)
        this.server = new Server(
            {
                name: config.name,
                version: config.version
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // SnapshotManager is core-free (JSON state only) — safe to load eagerly.
        this.snapshotManager = new SnapshotManager();
        this.snapshotManager.loadCodebaseSnapshot();

        this.setupTools();
    }

    /**
     * Lazily construct the heavy indexing engine (core Context + Milvus + embeddings
     * + handlers) exactly once. Deferred until AFTER the stdio transport connects so
     * the MCP `initialize` handshake is never blocked by the ~80s cold Milvus import
     * (the cause of MCP error -32001). Idempotent: concurrent callers await the same
     * promise; on failure the promise is reset so a later tool call can retry.
     */
    private ensureInitialized(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = (async () => {
                const t0 = Date.now();
                console.log('[INIT] Lazy-loading core indexing engine (Milvus / tree-sitter / embeddings)...');
                const { Context, MilvusVectorDatabase } = await import("@zilliz/claude-context-core");
                const { createEmbeddingInstance, logEmbeddingProviderInfo } = await import("./embedding.js");
                const { SyncManager } = await import("./sync.js");
                const { ToolHandlers } = await import("./handlers.js");

                console.log(`[EMBEDDING] Initializing embedding provider: ${this.config.embeddingProvider} (model: ${this.config.embeddingModel})`);
                const embedding = createEmbeddingInstance(this.config);
                logEmbeddingProviderInfo(this.config, embedding);

                const vectorDatabase = new MilvusVectorDatabase({
                    address: this.config.milvusAddress,
                    ...(this.config.milvusToken && { token: this.config.milvusToken })
                });

                this.context = new Context({
                    embedding,
                    vectorDatabase,
                    collectionNameOverride: this.config.collectionNameOverride
                });
                this.syncManager = new SyncManager(this.context, this.snapshotManager);
                this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager);

                // One-shot legacy 0/0+completed snapshot healing (Issue #295) — now
                // runs AFTER connect so it can't block the handshake.
                await this.toolHandlers.validateLegacyZeroEntries();
                // Periodic background sync.
                this.syncManager.startBackgroundSync();
                console.log(`[INIT] Core indexing engine ready in ${Date.now() - t0}ms`);
            })().catch((err) => {
                // Reset so a subsequent tool call can retry initialization.
                this.initPromise = null;
                throw err;
            });
        }
        return this.initPromise;
    }

    private setupTools() {
        const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;


        const search_description = `
Search the indexed codebase using natural language queries within a specified absolute path.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.

🎯 **When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first.
- You can then use the index_codebase tool to index the codebase before searching again.
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "index_codebase",
                        description: index_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to index.`
                                },
                                force: {
                                    type: "boolean",
                                    description: "Force re-indexing even if already indexed",
                                    default: false
                                },
                                splitter: {
                                    type: "string",
                                    description: "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                                    enum: ["ast", "langchain"],
                                    default: "ast"
                                },
                                customExtensions: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                    default: []
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                    default: []
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the codebase"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                }
                            },
                            required: ["path", "query"]
                        }
                    },
                    {
                        name: "clear_index",
                        description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to clear.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to check status for.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                ]
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            // Ensure the heavy core engine is loaded before serving any tool call.
            // The first call may wait for the one-time lazy init (already warming in
            // the background since the transport connected); subsequent calls are free.
            await this.ensureInitialized();
            const handlers = this.toolHandlers!;

            switch (name) {
                case "index_codebase":
                    return await handlers.handleIndexCodebase(args);
                case "search_code":
                    return await handlers.handleSearchCode(args);
                case "clear_index":
                    return await handlers.handleClearIndex(args);
                case "get_indexing_status":
                    return await handlers.handleGetIndexingStatus(args);

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('Starting Context MCP server...');

        // Connect the stdio transport FIRST so the MCP `initialize` handshake
        // completes immediately. ALL heavy work (core/Milvus import, embedding
        // provider, legacy snapshot healing, background sync) is deferred to
        // ensureInitialized() and runs AFTER connect — this fixes the MCP -32001
        // startup timeout caused by the ~80s cold Milvus import blocking the handshake.
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");

        // IMPORTANT: do NOT eagerly warm the core engine here. Loading the Milvus
        // SDK evaluates synchronously (Node module eval / require blocks the event
        // loop ~7s warm, ~80s cold), which would stall the `initialize` RESPONSE even
        // though the transport is already listening — re-introducing MCP -32001.
        // The engine is loaded lazily on the FIRST tool call (CallTool → ensureInitialized),
        // so the handshake and tools/list are always served instantly; the one-time
        // load cost lands on the first index/search, which the user already expects
        // to take time.
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // Create configuration
    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.start();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
