import { Injectable, Logger } from '@nestjs/common';
import { Parser } from 'node-sql-parser';
import { Dialect } from '@prisma/client';

export type StatementClass = 'SELECT' | 'DML' | 'DDL' | 'DESTRUCTIVE' | 'UTILITY' | 'UNKNOWN';

export interface Classification {
  kind: StatementClass;
  requiresConfirm: boolean;
  command?: string;
  reason?: string;
}

const DIALECT_MAP: Record<Dialect, string> = {
  POSTGRES: 'postgresql',
  MYSQL: 'mysql',
  SQLITE: 'sqlite',
  MSSQL: 'transactsql',
};

/**
 * Words that mean "this statement can change something". Only consulted when
 * the parser failed to prove a statement's shape (see classifyByKeyword), so a
 * false positive costs an unparseable query a confirmation — never silent data
 * loss. `into` is included to catch `SELECT ... INTO OUTFILE` (a MySQL file
 * write that parses as a plain select) and `SELECT ... INTO newtable`.
 */
const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|truncate|alter|create|replace|merge|grant|revoke|exec|execute|call|into|backup|restore|shutdown|reindex|vacuum|copy|attach)\b|\b(sp_|xp_)\w+/i;

@Injectable()
export class SqlClassifierService {
  private readonly parser = new Parser();
  private readonly log = new Logger(SqlClassifierService.name);

  classify(sql: string, dialect: Dialect): Classification {
    const trimmed = sql.trim();
    const firstWord = (trimmed.match(/^\w+/) ?? [''])[0].toUpperCase();

    // Hard block: multiple statements (simple heuristic). Parser catches most,
    // but we also want to forbid semicolon-separated batches by default.
    const stripped = trimmed.replace(/;+\s*$/, '');
    if (/;\s*\S/.test(stripped)) {
      return { kind: 'UNKNOWN', requiresConfirm: true, command: firstWord, reason: 'Multiple statements not allowed' };
    }

    let ast: any;
    try {
      ast = this.parser.astify(sql, { database: DIALECT_MAP[dialect] });
    } catch (e) {
      this.log.debug(`Parse fail: ${(e as Error).message}`);
      // SECURITY: the parser could not tell us what this statement does, so we
      // must not assume it's a read. `SELECT 1 DROP TABLE users` fails to parse
      // and the keyword heuristic would call it SELECT — and the batch check
      // above misses it because T-SQL needs no semicolon between statements.
      // `proven: false` makes the heuristic refuse to label anything SELECT
      // when write/DDL keywords are present anywhere in the statement.
      return this.classifyByKeyword(firstWord, trimmed, false);
    }

    const node = Array.isArray(ast) ? ast[0] : ast;
    const type = (node?.type ?? '').toLowerCase();
    const cmd = type.toUpperCase() || firstWord;

    switch (type) {
      case 'select': {
        // SECURITY: not every parsed SELECT is a read. `SELECT ... INTO OUTFILE
        // '/path'` writes a file (MySQL) and `SELECT ... INTO newtable` creates
        // a table — both parse as type 'select' and would otherwise be handed to
        // VIEWERs as read-only. The AST sets `into.expr` for exactly these and
        // leaves it undefined for an ordinary select (even one containing the
        // literal string 'into'), so this keys off the parse, not a regex.
        if (node?.into?.expr) {
          const target = String(node.into.keyword ?? '').toUpperCase() === 'OUTFILE' ? 'file' : 'table';
          return {
            kind: 'DDL',
            requiresConfirm: true,
            command: 'SELECT INTO',
            reason: `SELECT ... INTO writes to a ${target}`,
          };
        }
        return { kind: 'SELECT', requiresConfirm: false, command: 'SELECT' };
      }
      case 'insert': return { kind: 'DML', requiresConfirm: false, command: 'INSERT' };
      case 'update': {
        const hasWhere = !!node.where;
        return {
          kind: hasWhere ? 'DML' : 'DESTRUCTIVE',
          requiresConfirm: !hasWhere,
          command: 'UPDATE',
          reason: hasWhere ? undefined : 'UPDATE without WHERE',
        };
      }
      case 'delete': {
        const hasWhere = !!node.where;
        return {
          kind: hasWhere ? 'DML' : 'DESTRUCTIVE',
          requiresConfirm: !hasWhere,
          command: 'DELETE',
          reason: hasWhere ? undefined : 'DELETE without WHERE',
        };
      }
      case 'drop':
      case 'truncate':
        return { kind: 'DESTRUCTIVE', requiresConfirm: true, command: cmd };
      case 'alter':
      case 'create':
      case 'rename':
        return { kind: 'DDL', requiresConfirm: type === 'alter', command: cmd };
      default:
        // The parser produced a node type we don't recognise (e.g. a CTE that
        // wraps an INSERT reports `type: undefined`), so we haven't proven this
        // is a read either — same fail-closed treatment as a parse failure.
        return this.classifyByKeyword(firstWord, trimmed, false);
    }
  }

  /**
   * Keyword fallback used when the parser can't classify a statement.
   *
   * `proven` says whether the parser actually confirmed the statement's shape.
   * When it didn't, a read-looking first word is NOT enough to call something a
   * SELECT: statements can be stacked without a semicolon (T-SQL), and a CTE can
   * hide a write. In that case any write/DDL keyword anywhere downgrades the
   * verdict to UNKNOWN, which VIEWERs are refused and others must confirm.
   */
  private classifyByKeyword(word: string, sql: string, proven = true): Classification {
    const hasWhere = /\bwhere\b/i.test(sql);
    const READ_WORDS = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'PRAGMA'];
    if (!proven && READ_WORDS.includes(word) && WRITE_KEYWORDS.test(sql)) {
      return {
        kind: 'UNKNOWN',
        requiresConfirm: true,
        command: word,
        reason: 'Could not verify this is a read-only statement',
      };
    }
    switch (word) {
      case 'SELECT': case 'WITH': case 'EXPLAIN': case 'SHOW': case 'DESCRIBE': case 'PRAGMA':
        return { kind: 'SELECT', requiresConfirm: false, command: word };
      case 'INSERT': return { kind: 'DML', requiresConfirm: false, command: word };
      case 'UPDATE': case 'DELETE':
        return hasWhere
          ? { kind: 'DML', requiresConfirm: false, command: word }
          : { kind: 'DESTRUCTIVE', requiresConfirm: true, command: word, reason: `${word} without WHERE` };
      case 'DROP': case 'TRUNCATE':
        return { kind: 'DESTRUCTIVE', requiresConfirm: true, command: word };
      case 'ALTER': return { kind: 'DDL', requiresConfirm: true, command: word };
      case 'CREATE': return { kind: 'DDL', requiresConfirm: false, command: word };
      default: return { kind: 'UNKNOWN', requiresConfirm: true, command: word };
    }
  }
}
