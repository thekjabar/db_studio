import { BadRequestException } from '@nestjs/common';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Reject obviously-bad identifiers before we even try to whitelist. */
export function assertIdentShape(s: string): void {
  if (typeof s !== 'string' || !IDENT_RE.test(s)) {
    throw new BadRequestException(`Invalid identifier: ${JSON.stringify(s)}`);
  }
}

export function quotePg(ident: string): string {
  assertIdentShape(ident);
  return `"${ident.replace(/"/g, '""')}"`;
}

export function quoteMysql(ident: string): string {
  assertIdentShape(ident);
  return `\`${ident.replace(/`/g, '``')}\``;
}

export function quoteSqlite(ident: string): string {
  assertIdentShape(ident);
  return `"${ident.replace(/"/g, '""')}"`;
}

export function quoteMssql(ident: string): string {
  assertIdentShape(ident);
  return `[${ident.replace(/]/g, ']]')}]`;
}

/**
 * Whitelist the given identifier against a list of known-good identifiers from
 * live introspection. Throws if not found.
 *
 * Also asserts shape first — defense in depth. If a caller ever seeds `allowed`
 * from untrusted input by mistake, a shape-invalid candidate still can't sneak
 * through just by appearing in the list.
 */
export function whitelistIdent(candidate: string, allowed: Iterable<string>): string {
  assertIdentShape(candidate);
  for (const a of allowed) if (a === candidate) return candidate;
  throw new BadRequestException(`Identifier not found in schema: ${candidate}`);
}

/**
 * Validate a user-supplied column "type" string (e.g. `text`, `numeric(10,2)`,
 * `timestamp with time zone`, `text[]`). Accepts letters/digits/spaces and a
 * small set of punctuation, rejects statement terminators and quotes so an
 * attacker can't tack on a second statement.
 *
 * Throws on reject. Returns the trimmed value on accept.
 */
const TYPE_RE = /^[A-Za-z][A-Za-z0-9 _(),\[\]]{0,127}$/;
export function assertSqlType(raw: string): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('Column type must be a string');
  }
  const t = raw.trim();
  if (!TYPE_RE.test(t)) {
    throw new BadRequestException(`Invalid column type: ${JSON.stringify(raw)}`);
  }
  return t;
}

/**
 * Validate a user-supplied ON DELETE / ON UPDATE action. Only a small set of
 * SQL-standard keywords is allowed — anything else is rejected to block
 * injection via FK clause building.
 */
const FK_ACTIONS = new Set(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION']);
export function assertFkAction(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const up = String(raw).toUpperCase();
  if (!FK_ACTIONS.has(up)) {
    throw new BadRequestException(`Invalid FK action: ${JSON.stringify(raw)}`);
  }
  return up;
}

/**
 * Validate a user-supplied DEFAULT expression. Defaults are inherently free-form
 * (literals, function calls, casts) so we can't whitelist structure. We only
 * reject obvious statement-terminator patterns and cap length.
 *
 * This is a shallow defense: this endpoint already requires EDITOR role, and an
 * editor can run arbitrary SQL via /query. The value here is reducing the blast
 * radius of accidentally-bad input (e.g. a paste that contains stray `;`).
 */
const EXPR_MAX_LEN = 1024;
function assertFreeExpr(kind: string, raw: string): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException(`${kind} must be a string`);
  }
  if (raw.length > EXPR_MAX_LEN) {
    throw new BadRequestException(`${kind} too long (max ${EXPR_MAX_LEN})`);
  }
  // SECURITY: reject ANY statement break, not just the "; --" form.
  //
  // This expression is concatenated into DDL and executed over the simple query
  // protocol, which runs batches — so `1; DROP TABLE users` was a working
  // stacked-query injection. The old comment argued that an EDITOR "can run
  // arbitrary SQL via /query anyway", but that stopped being true: /query
  // enforces the requireReview approval gate for DDL/destructive statements and
  // this endpoint does not, so this was a way around the approval workflow.
  //
  // A semicolon inside a quoted literal (DEFAULT 'a;b') is legitimate, so only
  // bare ones outside string literals are refused.
  if (hasBareSemicolon(raw)) {
    throw new BadRequestException(`${kind} may not contain multiple statements`);
  }
  return raw;
}

/**
 * True if `s` contains a `;` outside of a single-quoted literal. Doubled quotes
 * ('') are the SQL escape for a literal quote and stay inside the string.
 */
function hasBareSemicolon(s: string): boolean {
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      if (inString && s[i + 1] === "'") { i++; continue; } // escaped ''
      inString = !inString;
    } else if (c === ';' && !inString) {
      return true;
    }
  }
  return false;
}

export function assertDefaultExpr(raw: string): string {
  return assertFreeExpr('DEFAULT expression', raw);
}

export function assertCheckExpr(raw: string): string {
  return assertFreeExpr('CHECK expression', raw);
}
