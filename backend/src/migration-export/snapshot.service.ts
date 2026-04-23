import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Dialect, Role, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionsService } from '../connections/connections.service';
import type { ColumnMeta, ErDiagram, ForeignKeyMeta } from '../drivers/driver.interface';

export interface DiffResult {
  fromSnapshotId: string;
  dialect: Dialect;
  sql: string;
  summary: {
    addedTables: string[];
    droppedTables: string[];
    addedColumns: string[];
    droppedColumns: string[];
    changedColumns: string[];
    addedFks: string[];
    droppedFks: string[];
  };
}

@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
  ) {}

  /** Capture the current ER state and persist it. */
  async create(
    connectionId: string,
    userId: string,
    input: { name: string; schema?: string },
  ): Promise<{ id: string; name: string; createdAt: Date }> {
    if (!input.name.trim()) throw new BadRequestException('Snapshot name is required');
    const drv = await this.connections.buildDriverForRole(connectionId, Role.VIEWER);
    try {
      const er = await drv.introspectForER(input.schema);
      const saved = await this.prisma.schemaSnapshot.create({
        data: {
          connectionId,
          name: input.name.trim().slice(0, 200),
          dbSchema: input.schema ?? null,
          payload: er as unknown as Prisma.InputJsonValue,
          createdById: userId,
        },
      });
      return { id: saved.id, name: saved.name, createdAt: saved.createdAt };
    } finally {
      await drv.close().catch(() => {});
    }
  }

  async list(connectionId: string) {
    return this.prisma.schemaSnapshot.findMany({
      where: { connectionId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        dbSchema: true,
        createdAt: true,
        createdBy: { select: { email: true, displayName: true } },
      },
    });
  }

  async remove(connectionId: string, id: string) {
    const row = await this.prisma.schemaSnapshot.findUnique({ where: { id } });
    if (!row || row.connectionId !== connectionId) throw new NotFoundException('Snapshot not found');
    await this.prisma.schemaSnapshot.delete({ where: { id } });
    return { ok: true as const };
  }

  /** Diff: ALTER statements to take the snapshot's schema to the current live schema. */
  async diffAgainstCurrent(connectionId: string, snapshotId: string): Promise<DiffResult> {
    const snap = await this.prisma.schemaSnapshot.findUnique({ where: { id: snapshotId } });
    if (!snap || snap.connectionId !== connectionId) {
      throw new NotFoundException('Snapshot not found');
    }
    const drv = await this.connections.buildDriverForRole(connectionId, Role.VIEWER);
    let current: ErDiagram;
    try {
      current = await drv.introspectForER(snap.dbSchema ?? undefined);
    } finally {
      await drv.close().catch(() => {});
    }
    const before = snap.payload as unknown as ErDiagram;
    const dialect = (await this.connections.get(connectionId)).dialect;
    return renderDiff(before, current, dialect, snap.id);
  }
}

// ---- Pure diff logic (exported for tests) --------------------------------

type TableKey = string; // `${schema}.${name}`
type ColKey = string;   // `${schema}.${name}.${column}`
type FkKey = string;    // `${schema}.${table}.${fkname}`

function tableKey(t: { schema: string; name: string }): TableKey {
  return `${t.schema}.${t.name}`;
}

function columnKeysFor(t: { schema: string; name: string; columns: ColumnMeta[] }): Set<ColKey> {
  return new Set(t.columns.map((c) => `${t.schema}.${t.name}.${c.name}`));
}

export function renderDiff(
  before: ErDiagram,
  after: ErDiagram,
  dialect: Dialect,
  fromSnapshotId: string,
): DiffResult {
  const q = (s: string) => quoteIdent(s, dialect);

  const beforeTables = new Map<TableKey, (typeof before.tables)[number]>();
  before.tables.forEach((t) => beforeTables.set(tableKey(t), t));
  const afterTables = new Map<TableKey, (typeof after.tables)[number]>();
  after.tables.forEach((t) => afterTables.set(tableKey(t), t));

  const beforeFks = new Map<FkKey, ForeignKeyMeta>();
  before.foreignKeys.forEach((fk) => beforeFks.set(`${fk.schema}.${fk.table}.${fk.name}`, fk));
  const afterFks = new Map<FkKey, ForeignKeyMeta>();
  after.foreignKeys.forEach((fk) => afterFks.set(`${fk.schema}.${fk.table}.${fk.name}`, fk));

  const sql: string[] = [];
  const summary = {
    addedTables: [] as string[],
    droppedTables: [] as string[],
    addedColumns: [] as string[],
    droppedColumns: [] as string[],
    changedColumns: [] as string[],
    addedFks: [] as string[],
    droppedFks: [] as string[],
  };

  // 1) Drop FKs that no longer exist (before we touch the referenced tables).
  for (const [k, fk] of beforeFks) {
    if (!afterFks.has(k)) {
      summary.droppedFks.push(k);
      sql.push(
        `ALTER TABLE ${qualified(fk.schema, fk.table, dialect)} DROP CONSTRAINT ${q(fk.name)};`,
      );
    }
  }

  // 2) Drop tables that disappeared.
  for (const [k, t] of beforeTables) {
    if (!afterTables.has(k)) {
      summary.droppedTables.push(k);
      sql.push(`DROP TABLE ${qualified(t.schema, t.name, dialect)};`);
    }
  }

  // 3) Create tables that appeared.
  for (const [k, t] of afterTables) {
    if (!beforeTables.has(k)) {
      summary.addedTables.push(k);
      sql.push(renderCreateTable(t, dialect));
    }
  }

  // 4) For tables present in both, diff columns.
  for (const [k, beforeT] of beforeTables) {
    const afterT = afterTables.get(k);
    if (!afterT) continue;
    const beforeCols = new Map(beforeT.columns.map((c) => [c.name, c]));
    const afterCols = new Map(afterT.columns.map((c) => [c.name, c]));

    // Drop columns
    for (const [name] of beforeCols) {
      if (!afterCols.has(name)) {
        summary.droppedColumns.push(`${k}.${name}`);
        sql.push(
          `ALTER TABLE ${qualified(beforeT.schema, beforeT.name, dialect)} DROP COLUMN ${q(name)};`,
        );
      }
    }
    // Add columns
    for (const [name, col] of afterCols) {
      if (!beforeCols.has(name)) {
        summary.addedColumns.push(`${k}.${name}`);
        sql.push(
          `ALTER TABLE ${qualified(afterT.schema, afterT.name, dialect)} ADD COLUMN ${q(name)} ` +
            renderColumnDef(col) +
            ';',
        );
      }
    }
    // Changed columns — only detect shape changes. The SQL is conservative:
    // set type / nullability / default independently because Postgres, MySQL,
    // and MSSQL don't share a single "modify column" grammar.
    for (const [name, beforeCol] of beforeCols) {
      const afterCol = afterCols.get(name);
      if (!afterCol) continue;
      const changes = diffColumn(beforeCol, afterCol);
      if (changes.length === 0) continue;
      summary.changedColumns.push(`${k}.${name}: ${changes.map((c) => c.kind).join(', ')}`);
      for (const chg of changes) {
        sql.push(renderColumnChange(afterT.schema, afterT.name, name, chg, dialect));
      }
    }
  }

  // 5) Add FKs that are new (do this AFTER tables/columns exist).
  for (const [k, fk] of afterFks) {
    if (!beforeFks.has(k)) {
      summary.addedFks.push(k);
      sql.push(renderFk(fk, dialect));
    }
  }

  const header = [
    `-- Diff generated by DB Studio`,
    `-- From snapshot: ${fromSnapshotId}`,
    `-- Dialect: ${dialect}`,
    `-- Review each statement before running; some changes (DROP COLUMN, type changes)`,
    `-- are not reversible once applied.`,
    ``,
  ].join('\n');

  return {
    fromSnapshotId,
    dialect,
    sql: sql.length === 0 ? header + '-- No differences detected.' : header + sql.join('\n'),
    summary,
  };
}

function diffColumn(
  before: ColumnMeta,
  after: ColumnMeta,
): { kind: 'type' | 'nullable' | 'default'; value: unknown }[] {
  const out: { kind: 'type' | 'nullable' | 'default'; value: unknown }[] = [];
  if (before.dataType.trim() !== after.dataType.trim()) {
    out.push({ kind: 'type', value: after.dataType });
  }
  if (before.nullable !== after.nullable) {
    out.push({ kind: 'nullable', value: after.nullable });
  }
  if ((before.defaultValue ?? null) !== (after.defaultValue ?? null)) {
    out.push({ kind: 'default', value: after.defaultValue });
  }
  return out;
}

function renderColumnChange(
  schema: string,
  table: string,
  col: string,
  chg: { kind: 'type' | 'nullable' | 'default'; value: unknown },
  dialect: Dialect,
): string {
  const t = qualified(schema, table, dialect);
  const c = quoteIdent(col, dialect);
  if (dialect === Dialect.POSTGRES || dialect === Dialect.SQLITE) {
    if (chg.kind === 'type') return `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${chg.value};`;
    if (chg.kind === 'nullable')
      return chg.value
        ? `ALTER TABLE ${t} ALTER COLUMN ${c} DROP NOT NULL;`
        : `ALTER TABLE ${t} ALTER COLUMN ${c} SET NOT NULL;`;
    // default
    return chg.value == null
      ? `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`
      : `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${chg.value};`;
  }
  if (dialect === Dialect.MYSQL) {
    // MySQL's MODIFY COLUMN replaces the full definition, so collapse all
    // changes into one statement by emitting MODIFY with the new type and
    // nullability whenever any attribute differs.
    const typeStr = chg.kind === 'type' ? String(chg.value) : '';
    const nul = chg.kind === 'nullable' ? (chg.value ? 'NULL' : 'NOT NULL') : '';
    const def = chg.kind === 'default' && chg.value != null ? `DEFAULT ${chg.value}` : '';
    return `ALTER TABLE ${t} MODIFY COLUMN ${c} ${typeStr} ${nul} ${def};`.replace(/\s+;/, ';');
  }
  // MSSQL
  if (chg.kind === 'type')
    return `ALTER TABLE ${t} ALTER COLUMN ${c} ${chg.value};`;
  if (chg.kind === 'nullable')
    return `ALTER TABLE ${t} ALTER COLUMN ${c} ${chg.value ? 'NULL' : 'NOT NULL'};`;
  return chg.value == null
    ? `-- MSSQL requires the default constraint's name; review manually.`
    : `-- MSSQL default-swap requires named constraint; manual step needed.`;
}

function renderColumnDef(col: ColumnMeta): string {
  const parts: string[] = [col.dataType];
  if (!col.nullable) parts.push('NOT NULL');
  if (col.defaultValue != null && col.defaultValue !== '') parts.push(`DEFAULT ${col.defaultValue}`);
  return parts.join(' ');
}

function renderCreateTable(
  t: { schema: string; name: string; columns: ColumnMeta[] },
  dialect: Dialect,
): string {
  const lines: string[] = [];
  lines.push(`CREATE TABLE ${qualified(t.schema, t.name, dialect)} (`);
  const colLines = t.columns.map(
    (c) => `  ${quoteIdent(c.name, dialect)} ${renderColumnDef(c)}`,
  );
  const pks = t.columns.filter((c) => c.isPrimaryKey).map((c) => quoteIdent(c.name, dialect));
  if (pks.length > 0) colLines.push(`  PRIMARY KEY (${pks.join(', ')})`);
  lines.push(colLines.join(',\n'));
  lines.push(');');
  return lines.join('\n');
}

function renderFk(fk: ForeignKeyMeta, dialect: Dialect): string {
  const from = qualified(fk.schema, fk.table, dialect);
  const to = qualified(fk.refSchema, fk.refTable, dialect);
  const cols = fk.columns.map((c) => quoteIdent(c, dialect)).join(', ');
  const ref = fk.refColumns.map((c) => quoteIdent(c, dialect)).join(', ');
  return (
    `ALTER TABLE ${from} ADD CONSTRAINT ${quoteIdent(fk.name, dialect)} ` +
    `FOREIGN KEY (${cols}) REFERENCES ${to} (${ref})` +
    (fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
    (fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '') +
    ';'
  );
}

function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === Dialect.MYSQL) return `\`${name.replace(/`/g, '``')}\``;
  if (dialect === Dialect.MSSQL) return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function qualified(schema: string, name: string, dialect: Dialect): string {
  if (dialect === Dialect.SQLITE) return quoteIdent(name, dialect);
  return `${quoteIdent(schema, dialect)}.${quoteIdent(name, dialect)}`;
}
