import type { IKeyProvider } from '../key-provider.interface';

/**
 * AWS KMS-backed key provider. The master key is a Customer Master Key (CMK)
 * that lives inside KMS — this process never sees it. Every wrap/unwrap is an
 * API call to KMS, which authorizes via the host's IAM role or explicit creds.
 *
 * Setup:
 *   - Create a symmetric CMK in KMS, note its ARN.
 *   - Grant this service's IAM role `kms:Encrypt` + `kms:Decrypt` on that CMK.
 *   - Set env: KMS_PROVIDER=aws, AWS_KMS_KEY_ID=<arn>, AWS_REGION=<region>.
 *
 * Why use AWS SDK v3 lazily: the SDK adds ~6MB to cold-start and we don't want
 * to ship it in self-hosted containers that use the local provider. `import()`
 * defers the hit until KMS is actually configured.
 */
export class AwsKmsKeyProvider implements IKeyProvider {
  readonly id = 'aws-kms';
  private client: unknown = null;
  private EncryptCmd: unknown = null;
  private DecryptCmd: unknown = null;

  constructor(
    private readonly keyId: string,
    private readonly region: string,
  ) {
    if (!keyId) throw new Error('AwsKmsKeyProvider requires AWS_KMS_KEY_ID');
    if (!region) throw new Error('AwsKmsKeyProvider requires AWS_REGION');
  }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    // Dynamic import — if the SDK isn't installed we fail loudly with a clear
    // message rather than crashing boot.
    try {
      // @ts-expect-error -- optional peer dep, loaded only when AWS KMS is selected.
      const mod = await import('@aws-sdk/client-kms');
      this.client = new (mod as any).KMSClient({ region: this.region });
      this.EncryptCmd = (mod as any).EncryptCommand;
      this.DecryptCmd = (mod as any).DecryptCommand;
    } catch {
      throw new Error(
        `AWS KMS provider selected but @aws-sdk/client-kms is not installed. ` +
          `Run: pnpm add @aws-sdk/client-kms`,
      );
    }
  }

  async wrap(dek: Buffer): Promise<string> {
    await this.ensureClient();
    const cmd = new (this.EncryptCmd as any)({
      KeyId: this.keyId,
      Plaintext: dek,
    });
    const res = await (this.client as any).send(cmd);
    if (!res.CiphertextBlob) throw new Error('KMS Encrypt returned no ciphertext');
    return Buffer.from(res.CiphertextBlob).toString('base64');
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    await this.ensureClient();
    const cmd = new (this.DecryptCmd as any)({
      CiphertextBlob: Buffer.from(wrapped, 'base64'),
      // KeyId is optional on Decrypt for symmetric CMKs but passing it
      // ensures we fail fast on cross-CMK mix-ups.
      KeyId: this.keyId,
    });
    const res = await (this.client as any).send(cmd);
    if (!res.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return Buffer.from(res.Plaintext);
  }
}
