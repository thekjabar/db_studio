import type { IKeyProvider } from '../key-provider.interface';

/**
 * HashiCorp Vault Transit secrets engine. Vault stores the master key and
 * never returns it — we call /transit/encrypt and /transit/decrypt.
 *
 * Setup:
 *   vault secrets enable transit
 *   vault write -f transit/keys/dbdash
 *   # grant this process's token `transit/encrypt/dbdash` + `transit/decrypt/dbdash`
 *
 * Env: KMS_PROVIDER=vault, VAULT_ADDR=https://vault.example.com,
 *      VAULT_TOKEN=<service-token>, VAULT_TRANSIT_KEY=dbdash.
 *
 * For production AppRole / Kubernetes auth is strongly preferred over a
 * static token; swap in a token-renewal layer when you deploy that way.
 */
export class VaultKeyProvider implements IKeyProvider {
  readonly id = 'vault';

  constructor(
    private readonly addr: string,
    private readonly token: string,
    private readonly keyName: string,
  ) {
    if (!addr) throw new Error('VaultKeyProvider requires VAULT_ADDR');
    if (!token) throw new Error('VaultKeyProvider requires VAULT_TOKEN');
    if (!keyName) throw new Error('VaultKeyProvider requires VAULT_TRANSIT_KEY');
    this.addr = addr.replace(/\/$/, '');
  }

  async wrap(dek: Buffer): Promise<string> {
    const url = `${this.addr}/v1/transit/encrypt/${encodeURIComponent(this.keyName)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-vault-token': this.token, 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext: dek.toString('base64') }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vault encrypt failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data?: { ciphertext?: string } };
    const ct = json.data?.ciphertext;
    if (!ct) throw new Error('Vault encrypt: empty ciphertext');
    return ct; // Vault returns `vault:v1:<base64>` — keep as-is.
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    const url = `${this.addr}/v1/transit/decrypt/${encodeURIComponent(this.keyName)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-vault-token': this.token, 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertext: wrapped }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vault decrypt failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data?: { plaintext?: string } };
    const pt = json.data?.plaintext;
    if (!pt) throw new Error('Vault decrypt: empty plaintext');
    return Buffer.from(pt, 'base64');
  }
}
