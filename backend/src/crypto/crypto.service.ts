import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppConfigService } from '../config/config.service';
import { KeyProviderService } from './key-provider.service';

/**
 * Envelope-encryption service for small secrets.
 *
 * Every `encrypt` call:
 *   1. Generates a fresh 32-byte DEK.
 *   2. Encrypts the plaintext with AES-256-GCM using the DEK.
 *   3. Wraps the DEK with the primary key provider (local, AWS KMS, GCP KMS, Vault).
 *   4. Emits a versioned envelope:  v2:{providerId}:{wrappedDek}:{iv|tag|ct}
 *
 * Benefits vs the old single-master-key scheme:
 *   - The master key never lives on this host when a cloud KMS is used, so
 *     stealing the process environment + DB dump still can't decrypt anything.
 *   - Each record has its own key, so a DEK leak only burns one record.
 *   - All unwraps are logged in the KMS audit log — you can see every
 *     credential decryption attempt.
 *
 * Backward compatibility: the reader transparently handles v1 records (the
 * original format: `base64(iv|tag|ct)` with no provider tag). New records
 * are always written in v2.
 */
@Injectable()
export class CryptoService {
  private static readonly IV_LEN = 12;
  private static readonly TAG_LEN = 16;
  // `v2:` tagged envelopes let readers distinguish new from old. The colon
  // separator can't appear in base64, so split is unambiguous.
  private static readonly V2_PREFIX = 'v2:';

  constructor(
    private readonly cfg: AppConfigService,
    private readonly keys: KeyProviderService,
  ) {}

  async encrypt(plaintext: string, purpose = 'default'): Promise<string> {
    const dek = randomBytes(32);
    const iv = randomBytes(CryptoService.IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, ct]).toString('base64');

    const provider = this.keys.primary;
    const wrappedDek = await provider.wrap(dek);
    // Zero out the DEK ASAP. Node doesn't guarantee it stays wiped, but the
    // buffer won't dangle through later GC cycles with recoverable content.
    dek.fill(0);

    return `${CryptoService.V2_PREFIX}${provider.id}:${wrappedDek}:${payload}`;
  }

  async decrypt(blob: string, purpose = 'default'): Promise<string> {
    if (blob.startsWith(CryptoService.V2_PREFIX)) {
      return this.decryptV2(blob, purpose);
    }
    // v1: legacy format, uses the local master key directly as the DEK.
    // We still support reading these so existing rows keep working across
    // the upgrade without a forced re-write migration.
    return this.decryptV1(blob, purpose);
  }

  async encryptJson<T>(obj: T, purpose = 'default'): Promise<string> {
    return this.encrypt(JSON.stringify(obj), purpose);
  }

  async decryptJson<T>(blob: string, purpose = 'default'): Promise<T> {
    return JSON.parse(await this.decrypt(blob, purpose)) as T;
  }

  /** Whether a ciphertext is already in the new envelope format. Useful for
   *  migration jobs that re-encrypt legacy rows. */
  isV2(blob: string): boolean {
    return blob.startsWith(CryptoService.V2_PREFIX);
  }

  private async decryptV2(blob: string, purpose: string): Promise<string> {
    // Split into exactly 3 parts after the prefix. The payload is base64 and
    // can contain `+` / `/` / `=` but never `:`, so `split(':', 3)` on the
    // suffix is safe.
    const suffix = blob.slice(CryptoService.V2_PREFIX.length);
    const firstColon = suffix.indexOf(':');
    if (firstColon < 0) throw new Error('Malformed v2 envelope: missing provider separator');
    const providerId = suffix.slice(0, firstColon);
    const rest = suffix.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');
    if (secondColon < 0) throw new Error('Malformed v2 envelope: missing DEK separator');
    const wrappedDek = rest.slice(0, secondColon);
    const payload = rest.slice(secondColon + 1);

    const dek = await this.keys.unwrapCached(providerId, wrappedDek);
    try {
      const buf = Buffer.from(payload, 'base64');
      const iv = buf.subarray(0, CryptoService.IV_LEN);
      const tag = buf.subarray(CryptoService.IV_LEN, CryptoService.IV_LEN + CryptoService.TAG_LEN);
      const ct = buf.subarray(CryptoService.IV_LEN + CryptoService.TAG_LEN);
      const decipher = createDecipheriv('aes-256-gcm', dek, iv);
      decipher.setAAD(Buffer.from(purpose, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } finally {
      // Don't zero — the DEK is shared in the cache. Cache eviction clears it.
    }
  }

  private decryptV1(blob: string, purpose: string): string {
    const buf = Buffer.from(blob, 'base64');
    if (buf.length < CryptoService.IV_LEN + CryptoService.TAG_LEN) {
      throw new Error('Ciphertext too short');
    }
    const iv = buf.subarray(0, CryptoService.IV_LEN);
    const tag = buf.subarray(CryptoService.IV_LEN, CryptoService.IV_LEN + CryptoService.TAG_LEN);
    const ct = buf.subarray(CryptoService.IV_LEN + CryptoService.TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.cfg.encryptionKey, iv);
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
