import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { IKeyProvider } from '../key-provider.interface';

/**
 * Local AES-256-GCM key provider. The master key lives in an env var
 * (`ENCRYPTION_KEY`) loaded at startup. Good enough for self-host and dev.
 *
 * For production hosted deployments prefer AwsKmsKeyProvider / GcpKmsKeyProvider
 * / VaultKeyProvider so the master key never touches this host's filesystem
 * or env.
 *
 * Wrapped-DEK format (base64):  iv(12) | tag(16) | ciphertext(32)
 */
export class LocalKeyProvider implements IKeyProvider {
  readonly id = 'local';
  private static readonly IV_LEN = 12;

  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error(`LocalKeyProvider requires a 32-byte master key, got ${masterKey.length}`);
    }
  }

  async wrap(dek: Buffer): Promise<string> {
    if (dek.length !== 32) throw new Error('DEK must be 32 bytes');
    const iv = randomBytes(LocalKeyProvider.IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    const buf = Buffer.from(wrapped, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}
