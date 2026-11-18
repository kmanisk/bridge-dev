use bridge_types::{JsonRpcError, JsonRpcRequest, JsonRpcResponse, ToolDefinition};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct McpSession {
    pub id: String,
    pub created_at: Instant,
    pub last_active: Instant,
}

pub struct McpSessionManager {
    max_sessions: usize,
    idle_timeout: Duration,
    sessions: Mutex<HashMap<String, McpSession>>,
    lru_order: Mutex<VecDeque<String>>,
}

impl McpSessionManager {
    pub fn new(max_sessions: usize, idle_timeout: Duration) -> Self {
        Self {
            max_sessions,
            idle_timeout,
            sessions: Mutex::new(HashMap::new()),
            lru_order: Mutex::new(VecDeque::new()),
        }
    }

    pub fn count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn max(&self) -> usize {
        self.max_sessions
    }

    pub fn idle_timeout_sec(&self) -> u64 {
        self.idle_timeout.as_secs()
    }

    pub fn create_session(&self) -> String {
        let mut sessions = self.sessions.lock().unwrap();
        let mut lru = self.lru_order.lock().unwrap();

        // Evict expired or oldest session if cap is reached
        if sessions.len() >= self.max_sessions {
            if let Some(oldest_id) = lru.pop_front() {
                sessions.remove(&oldest_id);
            }
        }

        use std::time::SystemTime;
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let session_id = format!("sess-{:x}", nanos);

        let now = Instant::now();
        sessions.insert(
            session_id.clone(),
            McpSession {
                id: session_id.clone(),
                created_at: now,
                last_active: now,
            },
        );
        lru.push_back(session_id.clone());

        session_id
    }

    pub fn touch_session(&self, id: &str) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(sess) = sessions.get_mut(id) {
            sess.last_active = Instant::now();
            let mut lru = self.lru_order.lock().unwrap();
            lru.retain(|s| s != id);
            lru.push_back(id.to_string());
            true
        } else {
            false
        }
    }
}

pub fn format_namespaced_tool(provider: &str, tool: &str) -> String {
    format!("{}__{}", provider, tool)
}

pub fn list_native_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "system_context".to_string(),
            description: Some(
                "Load canonical system context and mint context authorization capability"
                    .to_string(),
            ),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "docs": { "type": "array", "items": { "type": "string" } }
                }
            }),
        },
        ToolDefinition {
            name: "filesystem_read_file".to_string(),
            description: Some(
                "Read text content of a file within authorized workspace roots".to_string(),
            ),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "filesystem_list_directory".to_string(),
            description: Some(
                "List entries in a directory within authorized workspace roots".to_string(),
            ),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                }
            }),
        },
    ]
}

pub fn handle_json_rpc(req: &JsonRpcRequest) -> JsonRpcResponse {
    match req.method.as_str() {
        "initialize" => JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: req.id.clone(),
            result: Some(serde_json::json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "bridge-dev",
                    "version": "0.1.0"
                }
            })),
            error: None,
        },
        "notifications/initialized" => JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: req.id.clone(),
            result: Some(serde_json::json!({})),
            error: None,
        },
        "tools/list" => JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: req.id.clone(),
            result: Some(serde_json::json!({
                "tools": list_native_tools()
            })),
            error: None,
        },
        _ => JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: req.id.clone(),
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("Method not found: {}", req.method),
                data: None,
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_manager_lru() {
        let mgr = McpSessionManager::new(2, Duration::from_secs(60));
        let s1 = mgr.create_session();
        let s2 = mgr.create_session();
        assert_eq!(mgr.count(), 2);

        let s3 = mgr.create_session();
        assert_eq!(mgr.count(), 2);
        // s1 should have been evicted
        assert!(!mgr.touch_session(&s1));
        assert!(mgr.touch_session(&s2));
        assert!(mgr.touch_session(&s3));
    }
}
