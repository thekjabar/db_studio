import { normalizeSql } from './slow-query.service';

describe('normalizeSql', () => {
  it('strips block and line comments (then collapses numeric literals)', () => {
    // Comments are removed first, then the remaining `1` gets replaced by ?
    // Both behaviors run together — we just want to verify neither leaks text.
    expect(normalizeSql('SELECT /* hi */ 1 -- bye\nFROM t')).toBe('SELECT ? FROM t');
  });

  it('replaces string literals with ?', () => {
    expect(normalizeSql("SELECT * FROM t WHERE name = 'alice'")).toBe(
      'SELECT * FROM t WHERE name = ?',
    );
  });

  it("handles doubled quotes inside strings", () => {
    expect(normalizeSql("SELECT 'it''s fine'")).toBe('SELECT ?');
  });

  it('collapses numeric literals including negatives and scientific', () => {
    expect(normalizeSql('SELECT * FROM t WHERE x = -42 AND y = 1.5e3')).toBe(
      'SELECT * FROM t WHERE x = ? AND y = ?',
    );
  });

  it('collapses IN lists to a single placeholder', () => {
    expect(normalizeSql('SELECT * FROM t WHERE id IN (1, 2, 3, 4)')).toBe(
      'SELECT * FROM t WHERE id IN (?)',
    );
  });

  it('clusters different literal sets to the same shape', () => {
    const a = normalizeSql("UPDATE users SET email = 'a@x' WHERE id = 1");
    const b = normalizeSql("UPDATE users SET email = 'b@y' WHERE id = 99");
    expect(a).toBe(b);
  });

  it('trims trailing semicolons and whitespace', () => {
    expect(normalizeSql('SELECT 1;  ')).toBe('SELECT ?');
  });

  it('preserves identifiers inside double quotes as strings (non-ideal but predictable)', () => {
    // Double-quoted strings get masked too — pg uses them as idents, but
    // most DBs use single quotes for strings. We prefer the conservative
    // mask to avoid leaking literal values into the shape hash.
    expect(normalizeSql('SELECT "col_name" FROM t')).toBe('SELECT ? FROM t');
  });
});
