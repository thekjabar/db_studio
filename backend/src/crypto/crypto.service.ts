import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppConfigService } from '../config/config.service';

/**
 * AES-256-GCM envelope encryption for small secrets (connection creds, TOTP secrets).
 * Format: base64( iv(12) | authTag(16) | ciphertext )
 * AAD includes a purpose string to bind ciphertext to its intended use.
 */
@Injectable()
export class CryptoService {
  private static readonly IV_LEN = 12;
  private static readonly TAG_LEN = 16;

  constructor(private readonly cfg: AppConfigService) {}

  encrypt(plaintext: string, purpose = 'default'): string {
    const iv = randomBytes(CryptoService.IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.cfg.encryptionKey, iv);
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }

  decrypt(blob: string, purpose = 'default'): string {
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
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  encryptJson<T>(obj: T, purpose = 'default'): string {
    return this.encrypt(JSON.stringify(obj), purpose);
  }

  decryptJson<T>(blob: string, purpose = 'default'): T {
    return JSON.parse(this.decrypt(blob, purpose)) as T;
  }
}
