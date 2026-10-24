use std::sync::Arc;
use wordcraft_agent_runtime::{claude::ClaudeCli, http, mcp};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--mcp") {
        // stdio MCP server. Snapshot: `--snapshot <file>` (preferred), else empty.
        let doc = match args.iter().position(|a| a == "--snapshot") {
            Some(i) => {
                let path = args
                    .get(i + 1)
                    .ok_or_else(|| anyhow::anyhow!("--snapshot requires a file path"))?;
                std::fs::read_to_string(path)
                    .map_err(|e| anyhow::anyhow!("cannot read snapshot file: {e}"))?
            }
            None => String::new(),
        };
        return mcp::serve_stdio(doc).await;
    }

    let cli = Arc::new(ClaudeCli::from_env());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3210").await?;
    eprintln!("wordcraft agent-runtime listening on http://127.0.0.1:3210 (provider: claude-code)");
    axum::serve(listener, http::router(cli)).await?;
    Ok(())
}
