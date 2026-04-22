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
      // Fall back to keyword heuristic.
      return this.classifyByKeyword(firstWord, trimmed);
    }

    const node = Array.isArray(ast) ? ast[0] : ast;
    const type = (node?.type ?? '').toLowerCase();
    const cmd = type.toUpperCase() || firstWord;

    switch (type) {
      case 'select': return { kind: 'SELECT', requiresConfirm: false, command: 'SELECT' };
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
        return this.classifyByKeyword(firstWord, trimmed);
    }
  }

  private classifyByKeyword(word: string, sql: string): Classification {
    const hasWhere = /\bwhere\b/i.test(sql);
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
