import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { parse as papaParse } from 'papaparse';
import { randomBytes } from 'crypto';
import { Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { ColumnMeta } from '../drivers/driver.interface';

// How long a parsed session can sit idle before we drop it. Keeps memory bounded
// without requiring Redis for state.
const SESSION_TTL_MS = 15 * 60_000;
// Upper bound on what we accept; ~50MB of text. Larger imports should use
// native bulk-loaders (\COPY etc).
const MAX_PARSED_ROWS = 500_000;
// How many preview rows the client sees on upload.
const SAMPLE_SIZE = 20;

export type ColumnMapping = {
  /** Index of the CSV column (0-based). `null` means "skip". */
  csvColumn: number | null;
  /** Column in the target table. */
  targetColumn: string;
};

interface Session {
  id: string;
  userId: string;
  connectionId: string;
  filename: string;
  headers: string[];
  rows: string[][]; // unparsed cell values, still strings
  createdAt: number;
  lastTouched: number;
}

export interface UploadResult {
  sessionId: string;
  filename: string;
  headers: string[];
  sample: Record<string, string>[];
  totalRows: number;
}

export interface DryRunReport {
  totalRows: number;
  okRows: number;
  errorRows: { rowIndex: number; message: string }[];
}

export interface CommitReport {
  inserted: number;
  failed: { rowIndex: number; message: string }[];
  durationMs: number;
}

@Injectable()
export class CsvImportService implements OnModuleDestroy {
  private readonly log = new Logger(CsvImportService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly connections: ConnectionsService) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    this.sessions.clear();
  }

  private sweep() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of this.sessions) {
      if (s.lastTouched < cutoff) this.sessions.delete(id);
    }
  }

  private touch(s: Session) {
    s.lastTouched = Date.now();
  }

  private getSession(userId: string, sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new NotFoundException('Import session not found or expired');
    if (s.userId !== userId) throw new NotFoundException('Import session not found or expired');
    this.touch(s);
    return s;
  }

  async upload(
    userId: string,
    connectionId: string,
    filename: string,
    buffer: Buffer,
  ): Promise<UploadResult> {
    const text = buffer.toString('utf8');
    const parsed = papaParse<string[]>(text, {
      skipEmptyLines: true,
    });
    if (parsed.errors.length > 0) {
      // Only surface the first error — the rest are usually downstream.
      const first = parsed.errors[0];
      throw new BadRequestException(`CSV parse error: ${first.message} (row ${first.row})`);
    }
    if (parsed.data.length === 0) {
      throw new BadRequestException('CSV contains no rows');
    }
    const [headers, ...rows] = parsed.data as string[][];
    if (!headers || headers.length === 0) {
      throw new BadRequestException('CSV has no header row');
    }
    if (rows.length > MAX_PARSED_ROWS) {
      throw new BadRequestException(
        `File has ${rows.length} rows; max supported via import UI is ${MAX_PARSED_ROWS}`,
      );
    }

    const id = randomBytes(16).toString('base64url');
    const now = Date.now();
    this.sessions.set(id, {
      id,
      userId,
      connectionId,
      filename,
      headers: headers.map((h) => h.trim()),
      rows,
      createdAt: now,
      lastTouched: now,
    });

    const sample: Record<string, string>[] = [];
    for (let i = 0; i < Math.min(rows.length, SAMPLE_SIZE); i++) {
      const row: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) {
        row[headers[c]] = rows[i][c] ?? '';
      }
      sample.push(row);
    }
    return { sessionId: id, filename, headers, sample, totalRows: rows.length };
  }

  async discard(userId: string, sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s && s.userId === userId) this.sessions.delete(sessionId);
  }

  /** Build a reverse map target column name → CSV column index (or null to skip). */
  private buildMapIndex(headers: string[], mappings: ColumnMapping[]) {
    return mappings.map((m) => ({
      targetColumn: m.targetColumn,
      csvIndex: m.csvColumn,
    }));
  }

  /** Coerce a string cell into a JS value appropriate for a target column type.
   *  Conservative — returns null on empty strings, throws on clear type conflicts. */
  private coerce(value: string, col: ColumnMeta): unknown {
    if (value === '' || value === undefined) {
      if (!col.nullable && col.defaultValue === null) {
        throw new Error(`Column ${col.name} is NOT NULL and has no default`);
      }
      return null;
    }
    const t = col.dataType.toLowerCase();
    // Numeric types
    if (/\b(int|integer|bigint|smallint|serial|numeric|decimal|real|double|float)\b/.test(t)) {
      const n = Number(value);
      if (Number.isNaN(n)) throw new Error(`Column ${col.name}: "${value}" is not a number`);
      // Integers: reject fractional input.
      if (/\b(int|integer|bigint|smallint|serial)\b/.test(t) && !Number.isInteger(n)) {
        throw new Error(`Column ${col.name}: "${value}" has a fractional part`);
      }
      return n;
    }
    // Boolean types
    if (/\bbool/.test(t)) {
      const v = value.trim().toLowerCase();
      if (['true', 't', '1', 'yes', 'y'].includes(v)) return true;
      if (['false', 'f', '0', 'no', 'n'].includes(v)) return false;
      throw new Error(`Column ${col.name}: "${value}" is not a valid boolean`);
    }
    // JSON types — parse to object so the driver handles serialization.
    if (/\bjson/.test(t)) {
      try {
        return JSON.parse(value);
      } catch {
        throw new Error(`Column ${col.name}: "${value}" is not valid JSON`);
      }
    }
    // Everything else (text, varchar, timestamp, uuid, etc.) passes through
    // as a string. The driver handles DB-specific coercion.
    return value;
  }

  private async loadColumns(connectionId: string, userId: string, schema: string, table: string) {
    const drv = await this.connections.buildDriverForRole(connectionId, Role.EDITOR);
    try {
      return await drv.getTableColumns(schema, table);
    } finally {
      await drv.close().catch(() => {});
    }
  }

  async dryRun(
    userId: string,
    sessionId: string,
    schema: string,
    table: string,
    mappings: ColumnMapping[],
  ): Promise<DryRunReport> {
    const session = this.getSession(userId, sessionId);
    const cols = await this.loadColumns(session.connectionId, userId, schema, table);
    const colByName = new Map(cols.map((c) => [c.name, c]));
    const mapIndex = this.buildMapIndex(session.headers, mappings);

    // Validate mapping shape once — catches typos/missing columns before we
    // iterate 100k rows.
    for (const m of mapIndex) {
      const col = colByName.get(m.targetColumn);
      if (!col) throw new BadRequestException(`Column ${m.targetColumn} does not exist in ${schema}.${table}`);
    }
    // Any NOT NULL column without a default must be mapped.
    for (const c of cols) {
      if (!c.nullable && c.defaultValue == null && !c.isIdentity) {
        const hasMapping = mapIndex.some(
          (m) => m.targetColumn === c.name && m.csvIndex !== null,
        );
        if (!hasMapping) {
          throw new BadRequestException(`Column ${c.name} is required but no CSV column is mapped to it`);
        }
      }
    }

    const errorRows: { rowIndex: number; message: string }[] = [];
    let okRows = 0;
    for (let i = 0; i < session.rows.length; i++) {
      try {
        for (const m of mapIndex) {
          if (m.csvIndex === null) continue;
          const col = colByName.get(m.targetColumn)!;
          const raw = session.rows[i][m.csvIndex] ?? '';
          this.coerce(raw, col);
        }
        okRows++;
      } catch (err) {
        errorRows.push({ rowIndex: i, message: (err as Error).message });
        if (errorRows.length >= 100) break; // cap reporting so we don't OOM the response
      }
    }
    this.touch(session);
    return { totalRows: session.rows.length, okRows, errorRows };
  }

  async commit(
    userId: string,
    sessionId: string,
    schema: string,
    table: string,
    mappings: ColumnMapping[],
    options: { stopOnError?: boolean } = {},
  ): Promise<CommitReport> {
    const session = this.getSession(userId, sessionId);
    const cols = await this.loadColumns(session.connectionId, userId, schema, table);
    const colByName = new Map(cols.map((c) => [c.name, c]));
    const mapIndex = this.buildMapIndex(session.headers, mappings).filter((m) => m.csvIndex !== null);

    const started = Date.now();
    const failed: { rowIndex: number; message: string }[] = [];
    let inserted = 0;

    const drv = await this.connections.buildDriverForRole(session.connectionId, Role.EDITOR);
    try {
      for (let i = 0; i < session.rows.length; i++) {
        const values: Record<string, unknown> = {};
        try {
          for (const m of mapIndex) {
            const col = colByName.get(m.targetColumn)!;
            const raw = session.rows[i][m.csvIndex as number] ?? '';
            values[m.targetColumn] = this.coerce(raw, col);
          }
          await drv.insertRow(schema, table, values);
          inserted++;
        } catch (err) {
          failed.push({ rowIndex: i, message: (err as Error).message.slice(0, 400) });
          if (options.stopOnError) break;
          if (failed.length >= 1000) break;
        }
      }
    } finally {
      await drv.close().catch(() => {});
    }

    // Session stays alive so the user can see the result summary + optionally
    // re-commit after fixing the CSV. Sweeper will clean up eventually.
    this.touch(session);

    return { inserted, failed, durationMs: Date.now() - started };
  }
}
