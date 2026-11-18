use bridge_types::{OperationClass, SecurityProfile};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyConfig {
    pub profile: SecurityProfile,
    pub writable_roots: Vec<PathBuf>,
    pub protected_paths: Vec<PathBuf>,
    pub secret_paths: Vec<PathBuf>,
    pub secret_names: Vec<String>,
    pub allowed_commands: Vec<String>,
    pub approval_commands: Vec<String>,
    pub denied_commands: Vec<String>,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            profile: SecurityProfile::Standard,
            writable_roots: Vec::new(),
            protected_paths: vec![PathBuf::from("/etc/sudoers"), PathBuf::from("/boot")],
            secret_paths: Vec::new(),
            secret_names: vec![String::from(".env")],
            allowed_commands: vec![
                String::from("pwd"),
                String::from("git status"),
                String::from("ls"),
            ],
            approval_commands: vec![String::from("npm run build")],
            denied_commands: vec![String::from("rm -rf /")],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathDecision {
    pub allowed: bool,
    pub approval_required: bool,
}

pub fn check_path<P: AsRef<Path>>(
    target: P,
    mode: &str,
    config: &PolicyConfig,
) -> Result<PathDecision, &'static str> {
    let target_path = target.as_ref();

    // 1. Check secret file names
    if let Some(file_name) = target_path.file_name().and_then(|n| n.to_str()) {
        if config.secret_names.iter().any(|s| s == file_name) {
            return Err("SECRET_DENIED");
        }
    }

    // 2. Check secret directories / paths
    for secret in &config.secret_paths {
        if target_path.starts_with(secret) {
            return Err("SECRET_DENIED");
        }
    }

    // 3. Check protected system paths
    for prot in &config.protected_paths {
        if target_path.starts_with(prot) {
            return Err("PROTECTED_PATH");
        }
    }

    // 4. Writable root checks for writes
    if mode == "W" {
        let inside_root = config
            .writable_roots
            .iter()
            .any(|root| target_path.starts_with(root));
        if !inside_root {
            return Err("OUTSIDE_WRITABLE_ROOTS");
        }

        if config.profile == SecurityProfile::Strict {
            return Ok(PathDecision {
                allowed: true,
                approval_required: true,
            });
        }
    }

    Ok(PathDecision {
        allowed: true,
        approval_required: false,
    })
}

pub fn check_command(cmd: &str, config: &PolicyConfig) -> Result<OperationClass, &'static str> {
    let trimmed = cmd.trim();

    for denied in &config.denied_commands {
        if trimmed == denied || trimmed.starts_with(denied) {
            return Err("HIGH_RISK_DENIED");
        }
    }

    for allowed in &config.allowed_commands {
        if trimmed == allowed || trimmed.starts_with(allowed) {
            return Ok(OperationClass::ReadOnly);
        }
    }

    for approval in &config.approval_commands {
        if trimmed == approval || trimmed.starts_with(approval) {
            return Ok(OperationClass::RoutineEdit);
        }
    }

    if config.profile == SecurityProfile::Dangerous {
        Ok(OperationClass::RoutineEdit)
    } else {
        Err("POLICY_COMMAND_UNAPPROVED")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_path() {
        let root = PathBuf::from("/tmp/workspace");
        let config = PolicyConfig {
            profile: SecurityProfile::Standard,
            writable_roots: vec![root.clone()],
            secret_names: vec![".env".into()],
            secret_paths: vec![root.join(".ssh")],
            protected_paths: vec![PathBuf::from("/etc/sudoers")],
            ..Default::default()
        };

        // Workspace read/write
        assert!(check_path(root.join("src/index.ts"), "R", &config).is_ok());
        assert!(check_path(root.join("src/index.ts"), "W", &config).is_ok());

        // Secret denied
        assert_eq!(
            check_path(root.join(".env"), "R", &config),
            Err("SECRET_DENIED")
        );
        assert_eq!(
            check_path(root.join(".ssh/id_rsa"), "R", &config),
            Err("SECRET_DENIED")
        );

        // Outside roots write
        assert_eq!(
            check_path("/etc/rogue.service", "W", &config),
            Err("OUTSIDE_WRITABLE_ROOTS")
        );
    }

    #[test]
    fn test_check_command() {
        let config = PolicyConfig::default();
        assert_eq!(check_command("pwd", &config), Ok(OperationClass::ReadOnly));
        assert_eq!(check_command("rm -rf /", &config), Err("HIGH_RISK_DENIED"));
    }
}
