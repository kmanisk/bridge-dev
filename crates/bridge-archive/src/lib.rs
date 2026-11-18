pub struct ArchiveLimits {
    pub max_archive: usize,
    pub max_file: usize,
    pub max_total: usize,
    pub max_files: usize,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_archive: 16 * 1048576,
            max_file: 1048576,
            max_total: 16 * 1048576,
            max_files: 512,
        }
    }
}

pub fn safe_relative(input: &str) -> Result<&str, &'static str> {
    if input.is_empty() || input.len() > 240 {
        return Err("SOURCE_PATH_UNSAFE");
    }
    if input.contains('\\') || input.contains('\0') || input.starts_with('/') {
        return Err("SOURCE_PATH_UNSAFE");
    }
    let bytes = input.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err("SOURCE_PATH_UNSAFE");
    }

    for segment in input.split('/') {
        if segment == ".." || segment.is_empty() || segment == "." || segment == "__proto__" {
            return Err("SOURCE_PATH_UNSAFE");
        }
    }

    Ok(input)
}

pub fn check_entry_safety(
    mode: u32,
    size: usize,
    current_total: usize,
    limits: &ArchiveLimits,
) -> Result<(), &'static str> {
    // Check symlink: mode & 0o170000 == 0o120000
    if (mode & 0o170000) == 0o120000 {
        return Err("ZIP_UNSAFE_ENTRY");
    }
    if size > limits.max_file {
        return Err("ZIP_UNSAFE_ENTRY");
    }
    if current_total.saturating_add(size) > limits.max_total {
        return Err("ZIP_UNSAFE_ENTRY");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_relative() {
        assert!(safe_relative("package/index.js").is_ok());
        assert!(safe_relative("src/tools/audit.ts").is_ok());
        assert!(safe_relative("../evil.txt").is_err());
        assert!(safe_relative("sub/../../evil.txt").is_err());
        assert!(safe_relative("/absolute/path").is_err());
        assert!(safe_relative("windows\\backslash").is_err());
        assert!(safe_relative("null\0byte").is_err());
        assert!(safe_relative("__proto__/polluted").is_err());
    }

    #[test]
    fn test_symlink_rejection() {
        let limits = ArchiveLimits::default();
        // 0o120777 = 41471
        assert_eq!(
            check_entry_safety(41471, 100, 0, &limits),
            Err("ZIP_UNSAFE_ENTRY")
        );
        // 0o100644 = 33188 (regular file)
        assert!(check_entry_safety(33188, 100, 0, &limits).is_ok());
    }
}
