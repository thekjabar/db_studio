import { SqlClassifierService } from './sql-classifier.service';
import { Dialect } from '@prisma/client';

describe('SqlClassifierService', () => {
  const s = new SqlClassifierService();

  it('classifies SELECT as non-destructive', () => {
    const c = s.classify('SELECT 1', Dialect.POSTGRES);
    expect(c.kind).toBe('SELECT');
    expect(c.requiresConfirm).toBe(false);
  });

  it('flags DELETE without WHERE as destructive', () => {
    const c = s.classify('DELETE FROM users', Dialect.POSTGRES);
    expect(c.kind).toBe('DESTRUCTIVE');
    expect(c.requiresConfirm).toBe(true);
  });

  it('allows DELETE with WHERE', () => {
    const c = s.classify('DELETE FROM users WHERE id = 1', Dialect.POSTGRES);
    expect(c.kind).toBe('DML');
    expect(c.requiresConfirm).toBe(false);
  });

  it('flags DROP TABLE as destructive', () => {
    const c = s.classify('DROP TABLE users', Dialect.POSTGRES);
    expect(c.kind).toBe('DESTRUCTIVE');
    expect(c.requiresConfirm).toBe(true);
  });

  it('rejects multi-statement batches', () => {
    const c = s.classify('SELECT 1; DROP TABLE x;', Dialect.POSTGRES);
    expect(c.requiresConfirm).toBe(true);
  });
});
