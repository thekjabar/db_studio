import { CryptoService } from '../crypto/crypto.service';
import { AppConfigService } from '../config/config.service';

describe('CryptoService', () => {
  it('round-trips AES-256-GCM with purpose binding', () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/x';
    process.env.FRONTEND_ORIGIN = 'http://localhost:5173';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
    const cfg = new AppConfigService();
    const svc = new CryptoService(cfg);
    const ct = svc.encrypt('hello world', 'p1');
    expect(ct).not.toContain('hello');
    expect(svc.decrypt(ct, 'p1')).toBe('hello world');
    expect(() => svc.decrypt(ct, 'p2')).toThrow();
  });
});
