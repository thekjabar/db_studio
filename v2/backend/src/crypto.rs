//! Replicates v1's credential encryption so v2 can read connection secrets
//! stored by the Node backend and connect to the same target databases.
//!
//! Mirrors `crypto.service.ts` + `local-key.provider.ts`:
//!   - `ENCRYPTION_KEY` is base64 → a 32-byte master key.
//!   - v1 blob:  base64(iv(12) | tag(16) | ct)  — AES-256-GCM(master), AAD = purpose.
//!   - v2 blob:  `v2:{provider}:{wrappedDek}:{payload}`
//!       * wrappedDek = base64(iv|tag|ct(32)) — AES-256-GCM(master), NO AAD → 32-byte DEK.
//!       * payload    = base64(iv|tag|ct)     — AES-256-GCM(DEK), AAD = purpose.
//!   - credentials are encrypted with purpose `conn:{id}`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;

const V2_PREFIX: &str = "v2:";

#[derive(Clone)]
pub struct Crypto {
    master: [u8; 32],
}

impl Crypto {
    /// Build from `ENCRYPTION_KEY` (base64, must decode to 32 bytes). Returns
    /// `None`-friendly `Err` so the app can run without it (app-DB-only mode).
    pub fn from_env() -> anyhow::Result<Self> {
        let b64 = std::env::var("ENCRYPTION_KEY")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim())?;
        if bytes.len() != 32 {
            anyhow::bail!("ENCRYPTION_KEY must decode to 32 bytes, got {}", bytes.len());
        }
        let mut master = [0u8; 32];
        master.copy_from_slice(&bytes);
        Ok(Self { master })
    }

    /// AAD purpose used for a connection's credentials blob.
    pub fn conn_purpose(id: &str) -> String {
        format!("conn:{id}")
    }

    pub fn decrypt(&self, blob: &str, purpose: &str) -> anyhow::Result<String> {
        if let Some(rest) = blob.strip_prefix(V2_PREFIX) {
            self.decrypt_v2(rest, purpose)
        } else {
            self.decrypt_v1(blob, purpose)
        }
    }

    fn decrypt_v1(&self, blob: &str, purpose: &str) -> anyhow::Result<String> {
        let buf = b64(blob)?;
        let pt = gcm_decrypt(&self.master, &buf, purpose.as_bytes())?;
        Ok(String::from_utf8(pt)?)
    }

    fn decrypt_v2(&self, suffix: &str, purpose: &str) -> anyhow::Result<String> {
        // suffix = providerId : wrappedDek : payload
        let first = suffix.find(':').ok_or_else(|| anyhow::anyhow!("bad v2 envelope"))?;
        let provider = &suffix[..first];
        if provider != "local" {
            anyhow::bail!("unsupported key provider '{provider}' (v2 supports 'local' only)");
        }
        let rest = &suffix[first + 1..];
        let second = rest.find(':').ok_or_else(|| anyhow::anyhow!("bad v2 envelope"))?;
        let wrapped = &rest[..second];
        let payload = &rest[second + 1..];

        let dek = gcm_decrypt(&self.master, &b64(wrapped)?, b"")?;
        if dek.len() != 32 {
            anyhow::bail!("unwrapped DEK is not 32 bytes");
        }
        let pt = gcm_decrypt(&dek, &b64(payload)?, purpose.as_bytes())?;
        Ok(String::from_utf8(pt)?)
    }
}

fn b64(s: &str) -> anyhow::Result<Vec<u8>> {
    Ok(base64::engine::general_purpose::STANDARD.decode(s)?)
}

/// `buf` is Node's layout: iv(12) | tag(16) | ciphertext. The `aes-gcm` crate
/// wants ciphertext||tag, so we recombine before decrypting.
fn gcm_decrypt(key: &[u8], buf: &[u8], aad: &[u8]) -> anyhow::Result<Vec<u8>> {
    if buf.len() < 28 {
        anyhow::bail!("ciphertext too short");
    }
    let iv = &buf[0..12];
    let tag = &buf[12..28];
    let ct = &buf[28..];
    let mut combined = Vec::with_capacity(ct.len() + 16);
    combined.extend_from_slice(ct);
    combined.extend_from_slice(tag);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(iv);
    cipher
        .decrypt(nonce, Payload { msg: &combined, aad })
        .map_err(|_| anyhow::anyhow!("GCM authentication failed (wrong key or purpose)"))
}

/// Decoded connection credentials (shape from v1 `connections.dto.ts`).
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCredentials {
    pub host: String,
    pub port: u16,
    #[serde(alias = "username")]
    pub user: String,
    pub password: String,
    pub database: String,
    #[serde(default)]
    pub ssl_mode: Option<String>,
}
