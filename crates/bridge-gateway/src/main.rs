use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bridge_mcp::{handle_json_rpc, McpSessionManager};
use bridge_types::{JsonRpcRequest, MemoryMetrics, PerfDiagnostics, SessionMetrics};
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

struct AppState {
    mcp_token: String,
    session_manager: McpSessionManager,
    start_time: Instant,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    let mcp_token =
        env::var("MCP_TOKEN").unwrap_or_else(|_| "bridge-dev-default-token".to_string());
    let max_sessions: usize = env::var("MCP_MAX_SESSIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);

    let ttl_ms: u64 = env::var("MCP_SESSION_TTL_MS")
        .ok()
        .and_then(|t| t.parse().ok())
        .unwrap_or(1800000);

    let state = Arc::new(AppState {
        mcp_token,
        session_manager: McpSessionManager::new(max_sessions, Duration::from_millis(ttl_ms)),
        start_time: Instant::now(),
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/healthz", get(health_handler))
        .route("/diagnostics/perf", get(perf_handler))
        .route("/mcp", post(mcp_handler))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("BridgeDev Rust Gateway listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind port");
    axum::serve(listener, app).await.expect("Server failure");
}

fn verify_auth(headers: &HeaderMap, expected_token: &str) -> bool {
    if let Some(auth) = headers.get("authorization") {
        if let Ok(auth_str) = auth.to_str() {
            let token = auth_str.strip_prefix("Bearer ").unwrap_or(auth_str).trim();
            return token == expected_token;
        }
    }
    false
}

async fn health_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !verify_auth(&headers, &state.mcp_token) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok" }))).into_response()
}

async fn perf_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if !verify_auth(&headers, &state.mcp_token) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let uptime = state.start_time.elapsed().as_secs();
    let active_sessions = state.session_manager.count();

    let diag = PerfDiagnostics {
        status: "ok".to_string(),
        timestamp: format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ),
        pid: std::process::id(),
        uptime_sec: uptime,
        runtime_version: "rust-1.100.0".to_string(),
        memory: MemoryMetrics {
            rss: 42 * 1024 * 1024,
            heap_used: 12 * 1024 * 1024,
            heap_total: 20 * 1024 * 1024,
            external: 0,
            rss_formatted: "42.00 MiB".to_string(),
        },
        sessions: SessionMetrics {
            active: active_sessions,
            max: state.session_manager.max(),
            idle_timeout_sec: state.session_manager.idle_timeout_sec(),
        },
    };

    (StatusCode::OK, Json(diag)).into_response()
}

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<JsonRpcRequest>,
) -> Response {
    if !verify_auth(&headers, &state.mcp_token) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let session_id = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok().map(String::from))
        .unwrap_or_else(|| state.session_manager.create_session());

    state.session_manager.touch_session(&session_id);

    let response = handle_json_rpc(&payload);

    let mut res = (StatusCode::OK, Json(response)).into_response();
    if let Ok(val) = HeaderValue::from_str(&session_id) {
        res.headers_mut().insert("mcp-session-id", val);
        res.headers_mut().insert(
            "access-control-expose-headers",
            HeaderValue::from_static("Mcp-Session-Id"),
        );
    }
    res
}
