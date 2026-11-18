use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use bridge_types::{ContextTokenPayload, OperatorLease};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
pub enum CryptoError {
    Serialization(serde_json::Error),
    Hmac(String),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Serialization(e) => write!(f, "Serialization error: {}", e),
            Self::Hmac(e) => write!(f, "HMAC error: {}", e),
        }
    }
}

impl std::error::Error for CryptoError {}

impl From<serde_json::Error> for CryptoError {
    fn from(e: serde_json::Error) -> Self {
        Self::Serialization(e)
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in result {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", byte);
    }
    hex
}

pub fn mint_context_token(
    payload: &ContextTokenPayload,
    secret: &[u8],
) -> Result<String, CryptoError> {
    let json_bytes = serde_json::to_vec(payload)?;
    let enc_payload = URL_SAFE_NO_PAD.encode(&json_bytes);

    let mut mac =
        HmacSha256::new_from_slice(secret).map_err(|e| CryptoError::Hmac(e.to_string()))?;
    mac.update(enc_payload.as_bytes());
    let sig_bytes = mac.finalize().into_bytes();
    let enc_sig = URL_SAFE_NO_PAD.encode(sig_bytes);

    Ok(format!("{}.{}", enc_payload, enc_sig))
}

pub fn verify_context_token(token: &str, secret: &[u8], expected_subject: &str, now: u64) -> bool {
    if token.len() > 2048 {
        return false;
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 2 {
        return false;
    }
    let enc_payload = parts[0];
    let enc_sig = parts[1];

    let Ok(mut mac) = HmacSha256::new_from_slice(secret) else {
        return false;
    };
    mac.update(enc_payload.as_bytes());

    let Ok(sig_bytes) = URL_SAFE_NO_PAD.decode(enc_sig) else {
        return false;
    };
    if mac.verify_slice(&sig_bytes).is_err() {
        return false;
    }

    let Ok(payload_bytes) = URL_SAFE_NO_PAD.decode(enc_payload) else {
        return false;
    };
    let Ok(payload) = serde_json::from_slice::<ContextTokenPayload>(&payload_bytes) else {
        return false;
    };

    if payload.v != 1 {
        return false;
    }
    if payload.subject != expected_subject {
        return false;
    }
    if payload.expires <= now {
        return false;
    }

    true
}

pub fn verify_operator_lease(lease: &OperatorLease, public_key_bytes: &[u8; 32], now: u64) -> bool {
    let Some(ref scope) = lease.scope else {
        return false;
    };
    if scope != "host-root-v1" {
        return false;
    }
    let Some(ref nonce) = lease.nonce else {
        return false;
    };
    if nonce.is_empty() {
        return false;
    }
    let Some(ref sig_base64) = lease.signature else {
        return false;
    };

    let is_permanent = lease.lifetime.as_deref() == Some("until_off") && lease.expires_at.is_none();
    let is_temporary = lease.lifetime.is_none() && lease.expires_at.is_some_and(|exp| exp > now);
    if !is_permanent && !is_temporary {
        return false;
    }

    let Ok(sig_bytes) = STANDARD.decode(sig_base64) else {
        return false;
    };
    if sig_bytes.len() != 64 {
        return false;
    }
    let Ok(signature) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(public_key_bytes) else {
        return false;
    };

    #[derive(serde::Serialize)]
    struct LeaseMessage<'a> {
        mode: &'a str,
        expires_at: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        nonce: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lifetime: Option<&'a str>,
    }

    let msg = LeaseMessage {
        mode: &lease.mode,
        expires_at: lease.expires_at,
        nonce: lease.nonce.as_deref(),
        scope: lease.scope.as_deref(),
        lifetime: lease.lifetime.as_deref(),
    };
    let Ok(msg_bytes) = serde_json::to_vec(&msg) else {
        return false;
    };

    verifying_key.verify(&msg_bytes, &signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mint_and_verify_context_token() {
        let payload = ContextTokenPayload {
            v: 1,
            issuer: "sess-01".into(),
            subject: "test-agent".into(),
            hash: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9".into(),
            expires: 4000000000000,
        };
        let secret = b"my-test-secret-32-bytes-long!!!!";
        let token = mint_context_token(&payload, secret).unwrap();

        assert!(verify_context_token(
            &token,
            secret,
            "test-agent",
            1700000000000
        ));
        assert!(!verify_context_token(
            &token,
            secret,
            "wrong-agent",
            1700000000000
        ));
        assert!(!verify_context_token(
            &token,
            secret,
            "test-agent",
            5000000000000
        ));
    }
}
