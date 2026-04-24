import type { IKeyProvider } from '../key-provider.interface';

/**
 * GCP Cloud KMS-backed key provider. Uses the REST API directly — the
 * @google-cloud/kms SDK pulls in grpc and a large dep tree we don't need.
 *
 * Setup:
 *   - Create a symmetric key in a keyring, note its resource name
 *     (`projects/P/locations/L/keyRings/R/cryptoKeys/K`).
 *   - Give this service's service account `roles/cloudkms.cryptoKeyEncrypterDecrypter`.
 *   - Set env: KMS_PROVIDER=gcp, GCP_KMS_KEY_NAME=<resource-name>.
 *
 * Auth: we rely on Application Default Credentials resolved via `google-auth-library`,
 * loaded lazily so it isn't a hard dep for self-host.
 */
export class GcpKmsKeyProvider implements IKeyProvider {
  readonly id = 'gcp-kms';
  private authClient: unknown = null;

  constructor(private readonly keyName: string) {
    if (!keyName) throw new Error('GcpKmsKeyProvider requires GCP_KMS_KEY_NAME');
  }

  private async token(): Promise<string> {
    if (!this.authClient) {
      try {
        // @ts-expect-error -- optional peer dep, loaded only when GCP KMS is selected.
        const { GoogleAuth } = await import('google-auth-library');
        const auth = new (GoogleAuth as any)({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
        this.authClient = await auth.getClient();
      } catch {
        throw new Error(
          `GCP KMS provider selected but google-auth-library is not installed. ` +
            `Run: pnpm add google-auth-library`,
        );
      }
    }
    const tok = await (this.authClient as any).getAccessToken();
    const t = typeof tok === 'string' ? tok : tok?.token;
    if (!t) throw new Error('GCP auth returned empty access token');
    return t;
  }

  async wrap(dek: Buffer): Promise<string> {
    const token = await this.token();
    const url = `https://cloudkms.googleapis.com/v1/${this.keyName}:encrypt`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ plaintext: dek.toString('base64') }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GCP KMS encrypt failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { ciphertext?: string };
    if (!json.ciphertext) throw new Error('GCP KMS encrypt: empty ciphertext');
    return json.ciphertext; // already base64
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    const token = await this.token();
    const url = `https://cloudkms.googleapis.com/v1/${this.keyName}:decrypt`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ciphertext: wrapped }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GCP KMS decrypt failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { plaintext?: string };
    if (!json.plaintext) throw new Error('GCP KMS decrypt: empty plaintext');
    return Buffer.from(json.plaintext, 'base64');
  }
}
