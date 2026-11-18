use bridge_crypto::sha256_hex;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub ts: String,
    pub phase: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub prev_hash: String,
    pub entry_hash: String,
}

pub struct HashAudit {
    path: PathBuf,
    last_hash: Mutex<String>,
}

impl HashAudit {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            last_hash: Mutex::new(String::from(
                "0000000000000000000000000000000000000000000000000000000000000000",
            )),
        }
    }

    pub fn append(
        &self,
        phase: &str,
        status: &str,
        session_id: Option<&str>,
        mcp_session_id: Option<&str>,
        reason: Option<&str>,
    ) -> io::Result<AuditEntry> {
        let mut last_hash_lock = self.last_hash.lock().unwrap();
        let prev_hash = last_hash_lock.clone();

        let ts = chrono_like_now();
        let payload = format!(
            "{}:{}:{}:{}:{}:{}",
            ts,
            phase,
            status,
            session_id.unwrap_or(""),
            reason.unwrap_or(""),
            prev_hash
        );
        let entry_hash = sha256_hex(payload.as_bytes());

        let entry = AuditEntry {
            ts,
            phase: phase.to_string(),
            status: status.to_string(),
            session_id: session_id.map(String::from),
            mcp_session_id: mcp_session_id.map(String::from),
            reason: reason.map(String::from),
            prev_hash,
            entry_hash: entry_hash.clone(),
        };

        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;

        let line = serde_json::to_string(&entry)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        writeln!(file, "{}", line)?;

        *last_hash_lock = entry_hash;
        Ok(entry)
    }
}

fn chrono_like_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}", now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audit_append() {
        let temp_dir = std::env::temp_dir().join("bridge_audit_test");
        let audit_file = temp_dir.join("test_audit.jsonl");
        let _ = std::fs::remove_file(&audit_file);

        let audit = HashAudit::new(&audit_file);
        let e1 = audit
            .append("test_phase", "ok", Some("sess-1"), None, None)
            .unwrap();
        assert_eq!(
            e1.prev_hash,
            "0000000000000000000000000000000000000000000000000000000000000000"
        );

        let e2 = audit
            .append("test_phase", "ok", Some("sess-1"), None, Some("reason"))
            .unwrap();
        assert_eq!(e2.prev_hash, e1.entry_hash);

        let _ = std::fs::remove_file(&audit_file);
    }
}
