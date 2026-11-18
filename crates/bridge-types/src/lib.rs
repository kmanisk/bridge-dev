use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecurityProfile {
    Strict,
    Standard,
    Dangerous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationClass {
    ReadOnly,
    RoutineEdit,
    PrivilegedEdit,
    HighRisk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextTokenPayload {
    pub v: u32,
    pub issuer: String,
    pub subject: String,
    pub hash: String,
    pub expires: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorLease {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<String>,
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolEnvelope<T> {
    pub ok: bool,
    pub tool: String,
    pub summary: String,
    pub data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryMetrics {
    pub rss: u64,
    #[serde(rename = "heapUsed")]
    pub heap_used: u64,
    #[serde(rename = "heapTotal")]
    pub heap_total: u64,
    pub external: u64,
    #[serde(rename = "rssFormatted")]
    pub rss_formatted: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMetrics {
    pub active: usize,
    pub max: usize,
    #[serde(rename = "idleTimeoutSec")]
    pub idle_timeout_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerfDiagnostics {
    pub status: String,
    pub timestamp: String,
    pub pid: u32,
    #[serde(rename = "uptimeSec")]
    pub uptime_sec: u64,
    #[serde(rename = "nodeVersion")]
    pub runtime_version: String,
    pub memory: MemoryMetrics,
    pub sessions: SessionMetrics,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_profile_serialization() {
        let profile = SecurityProfile::Standard;
        let serialized = serde_json::to_string(&profile).unwrap();
        assert_eq!(serialized, "\"standard\"");
    }
}
