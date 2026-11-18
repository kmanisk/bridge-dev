use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub fn is_public_address(raw: &str) -> bool {
    let clean = raw.trim().trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = clean.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ipv4) => is_public_ipv4(ipv4),
            IpAddr::V6(ipv6) => is_public_ipv6(ipv6),
        }
    } else {
        false
    }
}

pub fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    let (a, b, c, _) = (octets[0], octets[1], octets[2], octets[3]);

    if a == 0 || a == 10 || a == 127 || a >= 224 {
        return false;
    }
    if a == 169 && b == 254 {
        return false;
    }
    if a == 172 && (16..=31).contains(&b) {
        return false;
    }
    if a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)) {
        return false;
    }
    if a == 100 && (64..=127).contains(&b) {
        return false;
    }
    if a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)) {
        return false;
    }
    if a == 203 && b == 0 && c == 113 {
        return false;
    }

    true
}

pub fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    let first = segments[0];
    let second = segments[1];

    if !(0x2000..=0x3fff).contains(&first) {
        return false;
    }
    if first == 0x2002 || first == 0x3fff {
        return false;
    }
    if first == 0x2001 && (second < 0x200 || second == 0xdb8) {
        return false;
    }

    true
}

pub fn validate_url(input: &str, allow_private: bool) -> Result<(), &'static str> {
    if !input.starts_with("https://") && !input.starts_with("http://") {
        return Err("SOURCE_URL_UNSAFE");
    }
    if input.starts_with("http://") && !allow_private {
        return Err("SOURCE_HTTPS_REQUIRED");
    }
    if input.contains('@') || input.contains('#') {
        return Err("SOURCE_URL_UNSAFE");
    }

    // Extract host
    let rest = if let Some(stripped) = input.strip_prefix("https://") {
        stripped
    } else if let Some(stripped) = input.strip_prefix("http://") {
        stripped
    } else {
        return Err("SOURCE_URL_UNSAFE");
    };

    let host = rest
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    let clean_host = host.trim_start_matches('[').trim_end_matches(']');

    if let Ok(ip) = clean_host.parse::<IpAddr>() {
        let is_pub = match ip {
            IpAddr::V4(v4) => is_public_ipv4(v4),
            IpAddr::V6(v6) => is_public_ipv6(v6),
        };
        if !is_pub && !allow_private {
            return Err("SOURCE_SSRF_DENIED");
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_public_ipv4() {
        assert!(is_public_address("8.8.8.8"));
        assert!(is_public_address("1.1.1.1"));
        assert!(!is_public_address("127.0.0.1"));
        assert!(!is_public_address("10.0.0.1"));
        assert!(!is_public_address("192.168.1.1"));
        assert!(!is_public_address("169.254.169.254"));
        assert!(!is_public_address("100.64.0.1"));
    }

    #[test]
    fn test_public_ipv6() {
        assert!(is_public_address("2607:f8b0:4005:805::200e"));
        assert!(!is_public_address("::1"));
        assert!(!is_public_address("fe80::1"));
        assert!(!is_public_address("2001:db8::1"));
    }
}
