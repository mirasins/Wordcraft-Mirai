use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use rmcp::{ServiceExt, model::CallToolRequestParams, transport::TokioChildProcess};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tower::ServiceExt as _;
use wordcraft_agent_runtime::{
    agent::{self, ChatMessage, ToolCall},
    claude::{self, CliStatus, LoginInfo, Provider, RunError, RunErrorKind, RunOutput},
    http::{router, router_with_origins},
    mcp,
};

fn first_text(result: &rmcp::model::CallToolResult) -> String {
    let v = serde_json::to_value(result).unwrap();
    v["content"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn mcp_in_process_handshake_list_call() {
    let client = mcp::connect_in_process("Hola mundo".into()).await.unwrap();
    assert!(client.peer_info().is_some());
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    let v = serde_json::to_value(&tools[0]).unwrap();
    assert_eq!(v["name"], mcp::GET_DOCUMENT_TOOL);
    assert_eq!(v["inputSchema"]["type"], "object");
    let r = client
        .call_tool(CallToolRequestParams::new(mcp::GET_DOCUMENT_TOOL))
        .await
        .unwrap();
    assert_eq!(first_text(&r), "Hola mundo");
    assert!(
        client
            .call_tool(CallToolRequestParams::new("nope"))
            .await
            .is_err()
    );
    client.cancel().await.unwrap();
}

/// Real stdio: spawn this crate's binary with `--mcp --snapshot <file>`, as Claude Code will.
#[tokio::test]
async fn mcp_stdio_binary_with_snapshot_file() {
    let dir = std::env::temp_dir().join(format!("wc-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let snap = dir.join("snapshot.txt");
    std::fs::write(&snap, "texto del snapshot ñ").unwrap();

    let exe = env!("CARGO_BIN_EXE_wordcraft-agent-runtime");
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--mcp").arg("--snapshot").arg(&snap);
    let transport = TokioChildProcess::new(cmd).unwrap();
    let client = ().serve(transport).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    let r = client
        .call_tool(CallToolRequestParams::new(mcp::GET_DOCUMENT_TOOL))
        .await
        .unwrap();
    assert_eq!(first_text(&r), "texto del snapshot ñ");
    client.cancel().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cli_args_are_locked_down() {
    let a = claude::build_args(Path::new("cfg.json"), Some("sonnet"));
    let has = |s: &str| a.iter().any(|x| x == s);
    assert!(has("-p") && has("--strict-mcp-config") && has("--no-session-persistence"));
    assert!(!has("--bare"));
    let pos = |s: &str| a.iter().position(|x| x == s).unwrap();
    assert_eq!(a[pos("--tools") + 1], "");
    assert_eq!(
        a[pos("--allowedTools") + 1],
        "mcp__wordcraft__wordcraft_get_document"
    );
    assert_eq!(a[pos("--permission-mode") + 1], "dontAsk");
    assert_eq!(a[pos("--output-format") + 1], "stream-json");
    assert_eq!(a[pos("--max-turns") + 1], "6");
    assert_eq!(a[pos("--model") + 1], "sonnet");
    assert_eq!(a[pos("--settings") + 1], r#"{"disableAllHooks":true}"#);
    assert!(!claude::build_args(Path::new("c"), None).contains(&"--model".to_string()));
}

#[test]
fn mcp_config_points_to_binary_with_snapshot() {
    let v = claude::mcp_config_json(Path::new("/x/agent"), Path::new("/t/snap.txt"));
    let s = &v["mcpServers"]["wordcraft"];
    assert_eq!(s["type"], "stdio");
    assert_eq!(s["args"], json!(["--mcp", "--snapshot", "/t/snap.txt"]));
}

#[test]
fn parse_stream_json_and_errors() {
    let ok = r#"{"type":"system","subtype":"init","model":"claude-x"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__wordcraft__wordcraft_get_document","input":{}}]}}
{"type":"user","message":{"content":[]}}
{"type":"result","subtype":"success","is_error":false,"result":"listo"}"#;
    let r = claude::parse_stream(ok).unwrap();
    assert_eq!(r.reply, "listo");
    assert_eq!(r.model, "claude-x");
    assert_eq!(
        r.tool_calls,
        vec![ToolCall {
            name: "wordcraft_get_document".into()
        }]
    );

    let bad = r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}"#;
    assert_eq!(
        claude::parse_stream(bad).unwrap_err().kind,
        RunErrorKind::NotLoggedIn
    );
    assert!(claude::parse_stream("garbage").is_err());
}

#[test]
fn status_and_url_parsing() {
    let s = claude::parse_status(r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}"#);
    assert!(s.logged_in && s.cli_installed);
    assert_eq!(s.auth_method.as_deref(), Some("claude.ai"));
    assert!(!claude::parse_status("not json").logged_in);
    assert_eq!(
        claude::extract_url("Visit https://claude.ai/oauth?x=1 to sign in").as_deref(),
        Some("https://claude.ai/oauth?x=1")
    );
}

struct Fake {
    status: CliStatus,
    seen: Mutex<Vec<String>>,
    logins: Mutex<u32>,
}

impl Provider for Fake {
    fn configured_model(&self) -> String {
        "claude-code-default".into()
    }
    async fn status(&self) -> CliStatus {
        self.status.clone()
    }
    async fn login(&self) -> Result<LoginInfo, RunError> {
        *self.logins.lock().unwrap() += 1;
        Ok(LoginInfo {
            started: true,
            running: true,
            message: "ok".into(),
            ..Default::default()
        })
    }
    async fn run(&self, m: &[ChatMessage], doc: &str) -> Result<RunOutput, RunError> {
        if !self.status.logged_in {
            return Err(RunError {
                kind: RunErrorKind::NotLoggedIn,
                message: "login".into(),
            });
        }
        self.seen.lock().unwrap().push(doc.to_string());
        Ok(RunOutput {
            reply: format!("echo {}", m.last().unwrap().content),
            tool_calls: vec![ToolCall {
                name: "wordcraft_get_document".into(),
            }],
            model: "m1".into(),
        })
    }
}

fn fake(logged_in: bool) -> Arc<Fake> {
    Arc::new(Fake {
        status: CliStatus {
            cli_installed: true,
            logged_in,
            ..Default::default()
        },
        seen: Mutex::new(vec![]),
        logins: Mutex::new(0),
    })
}

fn app(logged_in: bool) -> axum::Router {
    router(fake(logged_in))
}

async fn call(app: axum::Router, req: Request<Body>) -> (u16, Value) {
    let resp = app.oneshot(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn chat(body: Value) -> Request<Body> {
    Request::post("/api/agent/chat")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn http_validation_without_cli() {
    let doc = json!({"text":"d"});
    for body in [
        json!({"messages":[{"role":"system","content":"x"}],"document":doc}),
        json!({"messages":[],"document":doc}),
        json!({"messages":[{"role":"assistant","content":"x"}],"document":doc}),
        json!({"messages":[{"role":"user","content":"hi"}],"document":{"text":"a".repeat(agent::MAX_DOCUMENT_CHARS + 1)}}),
        json!({"nope":1}),
    ] {
        assert_eq!(call(app(true), chat(body)).await.0, 400);
    }
    let big = json!({"messages":[{"role":"user","content":"hi"}],"document":{"text":"a".repeat(2 << 20)}});
    assert_eq!(call(app(true), chat(big)).await.0, 413);
}

#[tokio::test]
async fn http_contract_login_health() {
    let ok = json!({"messages":[{"role":"user","content":"hi"}],"document":{"text":"abc"}});
    let (s, b) = call(app(true), chat(ok.clone())).await;
    assert_eq!(s, 200);
    assert_eq!(
        b,
        json!({"reply":"echo hi","toolCalls":[{"name":"wordcraft_get_document"}],"model":"m1"})
    );
    assert_eq!(call(app(false), chat(ok)).await.0, 401);

    let (_, h) = call(
        app(false),
        Request::get("/api/agent/health")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(h["ready"], false);
    assert_eq!(h["provider"], "claude-code");
    assert_eq!(h["loginRequired"], true);
    assert!(h.get("email").is_none());

    let (s, l) = call(
        app(false),
        Request::post("/api/agent/login")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(l["started"], true);
}

#[test]
fn only_claude_ai_account_is_ready() {
    let mk = |m: &str| claude::parse_status(&format!(r#"{{"loggedIn":true,"authMethod":"{m}"}}"#));
    assert!(mk("claude.ai").ready());
    assert!(!mk("api_key").ready());
    assert!(!mk("api_key_helper").ready());
    assert!(!mk("third_party").ready());
    assert!(!claude::parse_status(r#"{"loggedIn":false,"authMethod":"none"}"#).ready());
}

#[test]
fn login_info_running_is_started() {
    // Shape the UI relies on for the in-progress branch.
    let v = serde_json::to_value(LoginInfo {
        started: true,
        running: true,
        message: "m".into(),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(v["started"], true);
    assert_eq!(v["running"], true);
}

fn login_req(headers: &[(&str, &str)]) -> Request<Body> {
    let mut r = Request::post("/api/agent/login");
    for (k, v) in headers {
        r = r.header(*k, *v);
    }
    r.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn rejects_foreign_host_and_origin() {
    let p = fake(false);
    let app = || router_with_origins(p.clone(), vec!["http://localhost:3000".into()]);

    let (s, b) = call(app(), login_req(&[("host", "evil.example:3210")])).await;
    assert_eq!((s, b["error"].as_str()), (403, Some("Forbidden host")));
    let (s, b) = call(
        app(),
        Request::get("/api/agent/health")
            .header("host", "evil.example")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!((s, b["error"].as_str()), (403, Some("Forbidden host")));

    let (s, b) = call(
        app(),
        login_req(&[
            ("host", "127.0.0.1:3210"),
            ("origin", "https://evil.example"),
        ]),
    )
    .await;
    assert_eq!((s, b["error"].as_str()), (403, Some("Forbidden origin")));
    assert_eq!(*p.logins.lock().unwrap(), 0);

    // Allowed origin + host, and no Host/Origin at all, reach the provider.
    let ok = [
        ("host", "LocalHost:3210"),
        ("origin", "http://localhost:3000"),
    ];
    assert_eq!(call(app(), login_req(&ok)).await.0, 200);
    assert_eq!(call(app(), login_req(&[])).await.0, 200);
    assert_eq!(*p.logins.lock().unwrap(), 2);

    // A custom allowlist replaces the defaults.
    let custom = router_with_origins(p.clone(), vec!["https://app.example".into()]);
    let (s, _) = call(custom, login_req(&[("origin", "http://localhost:3000")])).await;
    assert_eq!(s, 403);
}
