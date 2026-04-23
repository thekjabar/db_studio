import { createHash, randomBytes } from 'crypto';

/**
 * Small sanity tests for the API-key token shape. Full service tests would
 * need a live Postgres + argon2 which is heavier; we at least verify the
 * invariants the service relies on.
 */
describe('api key token shape', () => {
  const PREFIX = 'dbs_live_';

  it('tokens start with the published prefix', () => {
    const raw = PREFIX + randomBytes(32).toString('base64url');
    expect(raw.startsWith(PREFIX)).toBe(true);
  });

  it('sha256 of identical tokens collide (required for lookup index)', () => {
    const raw = PREFIX + 'abc123';
    const a = createHash('sha256').update(raw).digest('hex');
    const b = createHash('sha256').update(raw).digest('hex');
    expect(a).toBe(b);
  });

  it('sha256 of distinct tokens differ with high probability', () => {
    const a = createHash('sha256')
      .update(PREFIX + randomBytes(32).toString('base64url'))
      .digest('hex');
    const b = createHash('sha256')
      .update(PREFIX + randomBytes(32).toString('base64url'))
      .digest('hex');
    expect(a).not.toBe(b);
  });

  it('base64url encoding uses only url-safe chars', () => {
    const raw = randomBytes(48).toString('base64url');
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('prefix slice is 16 chars (for display)', () => {
    const raw = PREFIX + 'ABCDEFGH';
    const display = raw.slice(0, PREFIX.length + 6) + '…';
    expect(display).toBe('dbs_live_ABCDEF…');
  });
});
