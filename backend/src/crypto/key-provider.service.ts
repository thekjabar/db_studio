import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { AppConfigService } from '../config/config.service';
import type { IKeyProvider } from './key-provider.interface';
import { LocalKeyProvider } from './providers/local-key.provider';
import { AwsKmsKeyProvider } from './providers/aws-kms-key.provider';
import { GcpKmsKeyProvider } from './providers/gcp-kms-key.provider';
import { VaultKeyProvider } from './providers/vault-key.provider';

/**
 * Registry of key providers. Keyed by provider id so a deployment can
 * support multiple (new writes via KMS, old reads via local) during a
 * migration window.
 *
 * Also wraps a short-TTL cache of unwrapped DEKs so the API doesn't call
 * KMS on every query — wrapped-DEK hash → raw DEK, 5-minute TTL.
 */
@Injectable()
export class KeyProviderService implements OnModuleInit {
  private readonly log = new Logger(KeyProviderService.name);
  private readonly providers = new Map<string, IKeyProvider>();
  private readonly cache = new Map<string, { dek: Buffer; at: number }>();
  private readonly CACHE_TTL_MS = 5 * 60_000;
  private readonly CACHE_MAX = 512;
  private _primary!: IKeyProvider;

  constructor(private readonly cfg: AppConfigService) {}

  onModuleInit(): void {
    // The local provider is always registered so historic ciphertexts that
    // were written before KMS was enabled can still be read.
    const local = new LocalKeyProvider(this.cfg.encryptionKey);
    this.providers.set(local.id, local);

    switch (this.cfg.kmsProvider) {
      case 'local':
        this._primary = local;
        break;
      case 'aws': {
        const p = new AwsKmsKeyProvider(
          this.cfg.awsKmsKeyId ?? '',
          this.cfg.awsRegion ?? '',
        );
        this.providers.set(p.id, p);
        this._primary = p;
        break;
      }
      case 'gcp': {
        const p = new GcpKmsKeyProvider(this.cfg.gcpKmsKeyName ?? '');
        this.providers.set(p.id, p);
        this._primary = p;
        break;
      }
      case 'vault': {
        const p = new VaultKeyProvider(
          this.cfg.vaultAddr ?? '',
          this.cfg.vaultToken ?? '',
          this.cfg.vaultTransitKey ?? '',
        );
        this.providers.set(p.id, p);
        this._primary = p;
        break;
      }
    }
    this.log.log(`KMS provider: ${this._primary.id} (${this.providers.size} registered)`);
  }

  /** Provider used for new writes. */
  get primary(): IKeyProvider {
    return this._primary;
  }

  /** Look up a provider by id, for reading old ciphertext under a different
   *  provider than the current primary. Throws if not registered. */
  byId(id: string): IKeyProvider {
    const p = this.providers.get(id);
    if (!p) {
      throw new Error(
        `No KMS provider registered for "${id}". ` +
          `If you recently switched KMS_PROVIDER you may still have old rows — ` +
          `re-register the old provider alongside the new one.`,
      );
    }
    return p;
  }

  /** Cached unwrap. Multiple decryptions of the same blob within the TTL
   *  hit the cache instead of KMS. */
  async unwrapCached(providerId: string, wrapped: string): Promise<Buffer> {
    const key = `${providerId}:${createHash('sha256').update(wrapped).digest('hex')}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.CACHE_TTL_MS) return hit.dek;
    const dek = await this.byId(providerId).unwrap(wrapped);
    this.cache.set(key, { dek, at: Date.now() });
    // Trim aggressively at the cap; LRU isn't worth the bookkeeping for 512 entries.
    if (this.cache.size > this.CACHE_MAX) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    return dek;
  }

  /** Drop a single entry — used after a forced rotation where we want the
   *  next unwrap to go to KMS (proving the new wrapped blob still resolves). */
  invalidate(providerId: string, wrapped: string): void {
    const key = `${providerId}:${createHash('sha256').update(wrapped).digest('hex')}`;
    this.cache.delete(key);
  }
}
