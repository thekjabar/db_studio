//! A three-call S3 client: PUT an object, list a prefix, delete a key.
//!
//! The AWS SDK would be ~40 crates and a few minutes of build time on a box
//! that takes eleven minutes to compile this binary already. What the backup
//! uploader actually needs is one signing algorithm (SigV4) and three HTTP
//! requests, which is what this is.
//!
//! Works against anything S3-compatible — Cloudflare R2, Backblaze B2, MinIO,
//! Wasabi, AWS — because the signature is the protocol. Path-style addressing
//! (`https://host/bucket/key`) is used throughout: R2 and MinIO require it, and
//! AWS still accepts it.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub(crate) struct Target {
    pub bucket: String,
    /// Empty for AWS; otherwise `https://<account>.r2.cloudflarestorage.com`.
    pub endpoint: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl Target {
    fn host_base(&self) -> String {
        if self.endpoint.is_empty() {
            format!("https://s3.{}.amazonaws.com", self.region)
        } else {
            self.endpoint.trim_end_matches('/').to_string()
        }
    }

    /// R2 ignores the region but requires a syntactically valid one, and
    /// signing with "auto" is what its own docs specify.
    fn signing_region(&self) -> &str {
        if self.region.is_empty() {
            "auto"
        } else {
            &self.region
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex(&h.finalize())
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

/// Percent-encode a path segment the way SigV4 requires: everything except
/// unreserved characters, and `/` kept as a separator.
fn uri_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn uri_encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

struct Signed {
    url: String,
    headers: Vec<(String, String)>,
}

/// Build the signed request. `query` must already be in the sorted, encoded
/// form SigV4 hashes — see the callers.
fn sign(
    t: &Target,
    method: &str,
    canonical_path: &str,
    query: &[(String, String)],
    payload_sha: &str,
    extra_headers: &[(&str, &str)],
) -> Result<Signed, String> {
    let base = t.host_base();
    let host = base
        .split("://")
        .nth(1)
        .ok_or_else(|| format!("endpoint is not a URL: {base}"))?
        .trim_end_matches('/')
        .to_string();

    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();

    let mut header_pairs: Vec<(String, String)> = vec![
        ("host".into(), host.clone()),
        ("x-amz-content-sha256".into(), payload_sha.to_string()),
        ("x-amz-date".into(), amz_date.clone()),
    ];
    for (k, v) in extra_headers {
        header_pairs.push((k.to_lowercase(), v.to_string()));
    }
    header_pairs.sort_by(|a, b| a.0.cmp(&b.0));

    let signed_headers = header_pairs
        .iter()
        .map(|(k, _)| k.clone())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = header_pairs
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect::<String>();

    let mut sorted_query = query.to_vec();
    sorted_query.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_query = sorted_query
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode_query(k), uri_encode_query(v)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_request = format!(
        "{method}\n{canonical_path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_sha}"
    );

    let scope = format!("{date_stamp}/{}/s3/aws4_request", t.signing_region());
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac(format!("AWS4{}", t.secret_access_key).as_bytes(), &date_stamp);
    let k_region = hmac(&k_date, t.signing_region());
    let k_service = hmac(&k_region, "s3");
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex(&hmac(&k_signing, &string_to_sign));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        t.access_key_id
    );

    let url = if canonical_query.is_empty() {
        format!("{base}{canonical_path}")
    } else {
        format!("{base}{canonical_path}?{canonical_query}")
    };

    let mut headers: Vec<(String, String)> = vec![
        ("x-amz-content-sha256".into(), payload_sha.to_string()),
        ("x-amz-date".into(), amz_date),
        ("authorization".into(), authorization),
    ];
    for (k, v) in extra_headers {
        headers.push((k.to_string(), v.to_string()));
    }
    Ok(Signed { url, headers })
}

async fn send(
    http: &reqwest::Client,
    method: reqwest::Method,
    signed: Signed,
    body: Option<Vec<u8>>,
) -> Result<String, String> {
    let mut req = http.request(method, &signed.url);
    for (k, v) in &signed.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        // S3 errors are XML with a <Message>; surface that rather than a wall.
        let msg = text
            .split("<Message>")
            .nth(1)
            .and_then(|s| s.split("</Message>").next())
            .unwrap_or(&text);
        return Err(format!("storage {status}: {}", msg.chars().take(300).collect::<String>()));
    }
    Ok(text)
}

/// Upload one object.
pub(crate) async fn put(
    http: &reqwest::Client,
    t: &Target,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let payload_sha = sha256_hex(&body);
    let path = uri_encode_path(&format!("/{}/{}", t.bucket, key));
    let len = body.len().to_string();
    let signed = sign(
        t,
        "PUT",
        &path,
        &[],
        &payload_sha,
        &[("content-type", content_type), ("content-length", &len)],
    )?;
    send(http, reqwest::Method::PUT, signed, Some(body)).await?;
    Ok(())
}

/// Every key under a prefix. Paginates until the listing is complete, because
/// retention that only sees the first 1000 objects silently stops pruning.
pub(crate) async fn list(
    http: &reqwest::Client,
    t: &Target,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let empty_sha = sha256_hex(b"");
    let path = uri_encode_path(&format!("/{}", t.bucket));
    let mut out: Vec<String> = Vec::new();
    let mut token: Option<String> = None;

    loop {
        let mut query: Vec<(String, String)> = vec![("list-type".into(), "2".into())];
        if !prefix.is_empty() {
            query.push(("prefix".into(), format!("{}/", prefix.trim_matches('/'))));
        }
        if let Some(tok) = &token {
            query.push(("continuation-token".into(), tok.clone()));
        }
        let signed = sign(t, "GET", &path, &query, &empty_sha, &[])?;
        let xml = send(http, reqwest::Method::GET, signed, None).await?;

        for chunk in xml.split("<Key>").skip(1) {
            if let Some(k) = chunk.split("</Key>").next() {
                out.push(k.to_string());
            }
        }
        token = xml
            .split("<NextContinuationToken>")
            .nth(1)
            .and_then(|s| s.split("</NextContinuationToken>").next())
            .map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    Ok(out)
}

/// Remove one object.
pub(crate) async fn delete(http: &reqwest::Client, t: &Target, key: &str) -> Result<(), String> {
    let empty_sha = sha256_hex(b"");
    let path = uri_encode_path(&format!("/{}/{}", t.bucket, key));
    let signed = sign(t, "DELETE", &path, &[], &empty_sha, &[])?;
    send(http, reqwest::Method::DELETE, signed, None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked example from AWS's own SigV4 documentation, so the signing
    /// chain is checked against a known-good signature rather than itself.
    #[test]
    fn signing_key_matches_the_aws_example() {
        let k_date = hmac(b"AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830");
        let k_region = hmac(&k_date, "us-east-1");
        let k_service = hmac(&k_region, "iam");
        let k_signing = hmac(&k_service, "aws4_request");
        assert_eq!(
            hex(&k_signing),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }

    #[test]
    fn paths_are_encoded_but_slashes_survive() {
        assert_eq!(uri_encode_path("/bucket/a b/c.sql"), "/bucket/a%20b/c.sql");
        assert_eq!(uri_encode_path("/bucket/x~y_z-1.dump"), "/bucket/x~y_z-1.dump");
        // A query value encodes its slashes; a path does not.
        assert_eq!(uri_encode_query("a/b"), "a%2Fb");
    }

    #[test]
    fn empty_payload_digest_is_the_well_known_one() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
