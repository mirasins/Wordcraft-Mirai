use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    handler::server::router::tool::ToolRouter,
    model::{CallToolResult, ContentBlock},
    service::{RoleClient, RunningService},
    tool, tool_handler, tool_router,
};
use std::sync::Arc;

pub const GET_DOCUMENT_TOOL: &str = "wordcraft_get_document";
pub const SERVER_NAME: &str = "wordcraft";

#[derive(Clone)]
pub struct WordcraftServer {
    document: Arc<String>,
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl WordcraftServer {
    pub fn new(document: String) -> Self {
        Self {
            document: Arc::new(document),
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "Returns the full plain text of the Wordcraft document currently open. Read-only.",
        annotations(read_only_hint = true)
    )]
    async fn wordcraft_get_document(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![ContentBlock::text(
            self.document.as_str(),
        )]))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for WordcraftServer {}

#[derive(Clone, Default)]
pub struct AgentClient;
impl rmcp::ClientHandler for AgentClient {}

pub type McpClient = RunningService<RoleClient, AgentClient>;

/// Runs the stdio MCP server (used by `--mcp`). Blocks until the client disconnects.
pub async fn serve_stdio(document: String) -> anyhow::Result<()> {
    let running = WordcraftServer::new(document)
        .serve(rmcp::transport::stdio())
        .await?;
    running.waiting().await?;
    Ok(())
}

/// Starts the rmcp server over an in-process duplex pipe and connects an rmcp client.
pub async fn connect_in_process(document: String) -> anyhow::Result<McpClient> {
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    let server = WordcraftServer::new(document);
    tokio::spawn(async move {
        if let Ok(running) = server.serve(server_io).await {
            let _ = running.waiting().await;
        }
    });
    AgentClient
        .serve(client_io)
        .await
        .map_err(|e| anyhow::anyhow!("mcp client handshake failed: {e}"))
}
