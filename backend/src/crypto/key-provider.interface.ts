/**
 * Envelope-encryption key provider. Wraps / unwraps short random DEKs
 * (data encryption keys). The master key lives inside the provider —
 * for cloud KMS providers it never leaves the KMS, so compromising this
 * host is not enough to decrypt anything.
 *
 * Every wrap returns an opaque string; the CryptoService stores it alongside
 * the ciphertext and passes it back to the same provider for unwrap. The
 * `providerId` is embedded in the envelope so a future deployment change
 * (e.g. moving from local to AWS KMS) can still read old records by
 * re-registering the old provider in parallel.
 */
export interface IKeyProvider {
  /** Short, stable identifier written into ciphertext envelopes. */
  readonly id: string;

  /** Encrypt a 32-byte DEK with the master key. Returns an opaque blob. */
  wrap(dek: Buffer): Promise<string>;

  /** Decrypt a wrapped DEK previously produced by this provider (or a
   *  compatible one). Returns the raw 32-byte DEK. */
  unwrap(wrapped: string): Promise<Buffer>;
}
