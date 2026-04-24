import { CryptoService } from '../crypto/crypto.service';
import { AppConfigService } from '../config/config.service';
import { KeyProviderService } from '../crypto/key-provider.service';

describe('CryptoService', () => {
  const setEnv = () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/x';
    process.env.FRONTEND_ORIGIN = 'http://localhost:5173';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
    delete process.env.KMS_PROVIDER;
  };

  const build = () => {
    setEnv();
    const cfg = new AppConfigService();
    const keys = new KeyProviderService(cfg);
    keys.onModuleInit();
    return new CryptoService(cfg, keys);
  };

  it('round-trips AES-256-GCM with purpose binding (v2 envelope)', async () => {
    const svc = build();
    const ct = await svc.encrypt('hello world', 'p1');
    expect(ct).toMatch(/^v2:local:/);
    expect(ct).not.toContain('hello');
    await expect(svc.decrypt(ct, 'p1')).resolves.toBe('hello world');
    await expect(svc.decrypt(ct, 'p2')).rejects.toThrow();
  });

  it('still reads legacy v1 ciphertext', async () => {
    // Hand-craft a v1 record using the same master key the service is
    // configured with. This proves the back-compat read path works so
    // existing rows keep decrypting after the upgrade.
    setEnv();
    const cfg = new AppConfigService();
    const keys = new KeyProviderService(cfg);
    keys.onModuleInit();
    const svc = new CryptoService(cfg, keys);
    const { createCipheriv, randomBytes } = await import('crypto');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cfg.encryptionKey, iv);
    cipher.setAAD(Buffer.from('p1', 'utf8'));
    const ct = Buffer.concat([cipher.update('hello v1', 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, tag, ct]).toString('base64');
    await expect(svc.decrypt(blob, 'p1')).resolves.toBe('hello v1');
  });
});
