use crate::agent::{self, ChatRequest};
use crate::claude::{Provider, RunErrorKind};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State, rejection::JsonRejection},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use std::sync::Arc;

pub const BODY_LIMIT_BYTES: usize = 1024 * 1024;

const ALLOWED_HOSTS: [&str; 2] = ["127.0.0.1:3210", "localhost:3210"];
const DEFAULT_ORIGINS: [&str; 2] = ["http://localhost:3000", "http://127.0.0.1:3000"];

/// Allowed `Origin`s: `WORDCRAFT_AGENT_ALLOWED_ORIGINS` (comma-separated) or the dev defaults.
fn origins_from_env() -> Vec<String> {
    let list: Vec<String> = std::env::var("WORDCRAFT_AGENT_ALLOWED_ORIGINS")
        .map(|v| {
            v.split(',')
                .map(|o| o.trim().to_string())
                .filter(|o| !o.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if list.is_empty() {
        DEFAULT_ORIGINS.iter().map(|o| o.to_string()).collect()
    } else {
        list
    }
}

pub fn router<P: Provider>(provider: Arc<P>) -> Router {
    router_with_origins(provider, origins_from_env())
}

/// Like `router`, with an explicit `Origin` allowlist.
pub fn router_with_origins<P: Provider>(provider: Arc<P>, origins: Vec<String>) -> Router {
    let origins = Arc::new(origins);
    Router::new()
        .route("/api/agent/health", get(health::<P>))
        .route("/api/agent/login", post(login::<P>))
        .route("/api/agent/chat", post(chat::<P>))
        .layer(DefaultBodyLimit::max(BODY_LIMIT_BYTES))
        .with_state(provider)
        .layer(middleware::from_fn(move |req, next| {
            guard(origins.clone(), req, next)
        }))
}

/// Rejects foreign `Host` (DNS rebinding) and foreign `Origin` (cross-site) requests.
async fn guard(origins: Arc<Vec<String>>, req: Request, next: Next) -> Response {
    let h = req.headers();
    if let Some(host) = h.get(header::HOST) {
        let ok = host
            .to_str()
            .is_ok_and(|v| ALLOWED_HOSTS.iter().any(|a| a.eq_ignore_ascii_case(v)));
        if !ok {
            return error(StatusCode::FORBIDDEN, "Forbidden host");
        }
    }
    if let Some(origin) = h.get(header::ORIGIN) {
        let ok = origin
            .to_str()
            .is_ok_and(|v| origins.iter().any(|a| a.eq_ignore_ascii_case(v)));
        if !ok {
            return error(StatusCode::FORBIDDEN, "Forbidden origin");
        }
    }
    next.run(req).await
}

fn error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({"error": msg.into()}))).into_response()
}

fn status_for(kind: RunErrorKind) -> StatusCode {
    match kind {
        RunErrorKind::NotInstalled => StatusCode::SERVICE_UNAVAILABLE,
        RunErrorKind::NotLoggedIn => StatusCode::UNAUTHORIZED,
        RunErrorKind::Timeout => StatusCode::GATEWAY_TIMEOUT,
        RunErrorKind::Busy => StatusCode::TOO_MANY_REQUESTS,
        RunErrorKind::Failed => StatusCode::BAD_GATEWAY,
    }
}

async fn health<P: Provider>(State(p): State<Arc<P>>) -> Json<serde_json::Value> {
    let s = p.status().await;
    let mut v = serde_json::to_value(&s).unwrap();
    v["ready"] = json!(s.ready());
    v["loginRequired"] = json!(s.cli_installed && !s.ready());
    v["provider"] = json!("claude-code");
    v["model"] = json!(p.configured_model());
    Json(v)
}

async fn login<P: Provider>(State(p): State<Arc<P>>) -> Response {
    match p.login().await {
        Ok(info) => Json(info).into_response(),
        Err(e) => error(status_for(e.kind), e.message),
    }
}

async fn chat<P: Provider>(
    State(p): State<Arc<P>>,
    body: Result<Json<ChatRequest>, JsonRejection>,
) -> Response {
    let req = match body {
        Ok(Json(r)) => r,
        Err(e) => {
            let status = if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_REQUEST
            };
            return error(status, format!("Invalid request: {}", e.body_text()));
        }
    };
    if let Err(msg) = agent::validate(&req) {
        return error(StatusCode::BAD_REQUEST, msg);
    }
    match p.run(&req.messages, &req.document.text).await {
        Ok(o) => Json(agent::ChatResponse {
            reply: o.reply,
            tool_calls: o.tool_calls,
            model: o.model,
        })
        .into_response(),
        Err(e) => error(status_for(e.kind), e.message),
    }
}
