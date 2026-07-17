import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Safe predicate grammar. We tokenize, check each token, and reject anything
 * we don't explicitly understand. This is stricter than "quote the inputs" —
 * we refuse to render unknown syntax rather than trust the DB parser to
 * interpret it the way we expect.
 *
 * Accepted tokens:
 *   - identifiers matching IDENT_RE (optionally schema.table.col form)
 *   - integer + decimal literals
 *   - single-quoted string literals with ''-escape
 *   - operators: = <> != < <= > >= IN
 *   - keywords: AND OR NOT IS NULL TRUE FALSE
 *   - parentheses + commas
 *   - the literal `:userId` placeholder, resolved at apply-time
 *
 * This is a deliberately small grammar — enough for "tenant_id = :userId",
 * "status IN ('ACTIVE','TRIAL')", or "org_id = :userId AND deleted = FALSE".
 * Complex filters belong in a dedicated view the connection owner exposes.
 */
const ALLOWED_OPS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);
const ALLOWED_KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'NULL',
  'TRUE',
  'FALSE',
  'IN',
]);

export function validatePredicate(raw: string): { ok: true } | { ok: false; error: string } {
  if (!raw || raw.length > 1000) return { ok: false, error: 'Predicate must be 1..1000 chars' };
  // Reject the obvious attack substrings before we even tokenize — semicolons,
  // comment markers, leading slash-star.
  if (/[;]|--|\/\*|\*\//.test(raw)) {
    return { ok: false, error: 'Disallowed character or comment' };
  }

  let i = 0;
  const n = raw.length;
  while (i < n) {
    // Skip whitespace.
    while (i < n && /\s/.test(raw[i])) i++;
    if (i >= n) break;
    const ch = raw[i];

    // Parens + comma.
    if (ch === '(' || ch === ')' || ch === ',') {
      i++;
      continue;
    }

    // :userId placeholder.
    if (ch === ':') {
      if (raw.slice(i, i + 7) === ':userId') {
        i += 7;
        continue;
      }
      return { ok: false, error: `Unknown placeholder at position ${i}` };
    }

    // Operators.
    const two = raw.slice(i, i + 2);
    if (ALLOWED_OPS.has(two)) {
      i += 2;
      continue;
    }
    if (ALLOWED_OPS.has(ch)) {
      i++;
      continue;
    }

    // String literal 'abc' or '' escape.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (raw[i] === "'") {
          if (raw[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Number.
    if (/[0-9]/.test(ch)) {
      while (i < n && /[0-9.]/.test(raw[i])) i++;
      continue;
    }

    // Identifier / keyword. Support dotted qualifiers.
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_.]/.test(raw[i])) i++;
      const tok = raw.slice(start, i);
      const upper = tok.toUpperCase();
      if (ALLOWED_KEYWORDS.has(upper)) continue;
      // Dotted identifier: every piece must match IDENT_RE.
      if (tok.split('.').every((p) => IDENT_RE.test(p))) continue;
      return { ok: false, error: `Invalid identifier "${tok}"` };
    }

    return { ok: false, error: `Unexpected character "${ch}" at position ${i}` };
  }
  return { ok: true };
}

/** Resolve :userId at apply time. The validator already restricted placeholders
 *  to the single token `:userId`, so a naive replace is safe. */
function applyPlaceholders(predicate: string, userId: string): string {
  // User id is a cuid — charset `[A-Za-z0-9]`. No escaping needed, but we
  // defensively single-quote it so it parses as a string literal in the DB.
  const safe = userId.replace(/[^A-Za-z0-9]/g, '');
  return predicate.replace(/:userId\b/g, `'${safe}'`);
}

@Injectable()
export class RowFiltersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Rendered WHERE clause (no leading `WHERE`) or null if no filter set. */
  async forUser(
    userId: string,
    connectionId: string,
    schemaName: string,
    tableName: string,
  ): Promise<string | null> {
    const row = await this.prisma.rowFilter.findUnique({
      where: {
        connectionId_userId_schemaName_tableName: {
          connectionId,
          userId,
          schemaName,
          tableName,
        },
      },
    });
    if (!row) return null;
    return applyPlaceholders(row.predicate, userId);
  }

  /**
   * Does this user have ANY row filter on this connection?
   *
   * SECURITY: a row filter is only enforceable where WE build the query (the
   * table browser), because appending a predicate to arbitrary user-supplied
   * SQL isn't possible. Raw-SQL paths therefore have to fail closed for a
   * filtered user — otherwise `SELECT * FROM orders` in the SQL editor returns
   * every row the filter was meant to hide, which made the whole control
   * decorative.
   */
  async hasAnyFor(userId: string, connectionId: string): Promise<boolean> {
    const n = await this.prisma.rowFilter.count({ where: { connectionId, userId } });
    return n > 0;
  }

  async list(connectionId: string) {
    const rows = await this.prisma.rowFilter.findMany({
      where: { connectionId },
      orderBy: [{ schemaName: 'asc' }, { tableName: 'asc' }],
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.user.email,
      displayName: r.user.displayName,
      schemaName: r.schemaName,
      tableName: r.tableName,
      predicate: r.predicate,
      createdAt: r.createdAt,
    }));
  }

  private async assertOwner(connectionId: string, actorUserId: string) {
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { ownerId: true },
    });
    if (!conn) throw new NotFoundException();
    if (conn.ownerId !== actorUserId) {
      throw new ForbiddenException('Only the connection owner can manage row filters');
    }
  }

  async upsert(
    connectionId: string,
    actorUserId: string,
    input: { email: string; schemaName: string; tableName: string; predicate: string },
  ) {
    await this.assertOwner(connectionId, actorUserId);
    if (![input.schemaName, input.tableName].every((s) => IDENT_RE.test(s))) {
      throw new BadRequestException('Invalid schema/table identifier');
    }
    const validation = validatePredicate(input.predicate);
    if (!validation.ok) {
      throw new BadRequestException(`Invalid predicate: ${validation.error}`);
    }
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
      select: { id: true, email: true, displayName: true },
    });
    if (!user) throw new NotFoundException(`No user with email ${input.email}`);

    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { ownerId: true },
    });
    if (conn?.ownerId === user.id) {
      throw new BadRequestException('Cannot filter rows for the connection owner');
    }

    const row = await this.prisma.rowFilter.upsert({
      where: {
        connectionId_userId_schemaName_tableName: {
          connectionId,
          userId: user.id,
          schemaName: input.schemaName,
          tableName: input.tableName,
        },
      },
      create: {
        connectionId,
        userId: user.id,
        schemaName: input.schemaName,
        tableName: input.tableName,
        predicate: input.predicate,
      },
      update: { predicate: input.predicate },
    });
    return {
      id: row.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      schemaName: row.schemaName,
      tableName: row.tableName,
      predicate: row.predicate,
      createdAt: row.createdAt,
    };
  }

  async remove(connectionId: string, actorUserId: string, id: string) {
    await this.assertOwner(connectionId, actorUserId);
    const existing = await this.prisma.rowFilter.findFirst({
      where: { id, connectionId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException();
    await this.prisma.rowFilter.delete({ where: { id } });
  }
}
