import { BadRequestException, Injectable } from '@nestjs/common';
import { Dialect, Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import type { ColumnMeta, ErDiagram, ForeignKeyMeta } from '../drivers/driver.interface';

export type MigrationTarget = 'prisma' | 'drizzle' | 'sql';

export interface ExportResult {
  target: MigrationTarget;
  filename: string;
  content: string;
}

@Injectable()
export class MigrationExportService {
  constructor(private readonly connections: ConnectionsService) {}

  async export(
    connectionId: string,
    target: MigrationTarget,
    schema?: string,
  ): Promise<ExportResult> {
    const drv = await this.connections.buildDriverForRole(connectionId, Role.VIEWER);
    try {
      const raw = await drv.introspectForER(schema);
      const er: ErDiagram = { ...raw, foreignKeys: raw.foreignKeys.map(normalizeFk) };
      switch (target) {
        case 'prisma':
          return {
            target,
            filename: 'schema.prisma',
            content: renderPrisma(er, drv.dialect),
          };
        case 'drizzle':
          return {
            target,
            filename: 'schema.ts',
            content: renderDrizzle(er, drv.dialect),
          };
        case 'sql':
          return {
            target,
            filename: 'schema.sql',
            content: renderSql(er, drv.dialect),
          };
        default:
          throw new BadRequestException(`Unknown target: ${target}`);
      }
    } finally {
      await drv.close().catch(() => {});
    }
  }
}

// ---- Shared helpers ------------------------------------------------------

/**
 * Turn a snake_case / plural name into a PascalCase singular identifier for
 * use as a Prisma / Drizzle model. Conservative — strips trailing "s", caps
 * first char, uppercases after underscores. Far from perfect (leaves
 * "Users" instead of "User" in some cases) but predictable.
 */
function pascalCase(s: string): string {
  const parts = s.split(/[_\s-]+/).filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
}

function camelCase(s: string): string {
  const parts = s.split(/[_\s-]+/).filter(Boolean);
  return parts
    .map((p, i) =>
      i === 0
        ? p.charAt(0).toLowerCase() + p.slice(1)
        : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
    )
    .join('');
}

/**
 * Coerce whatever the driver returned for an FK column list into a real JS
 * array. Postgres `array_agg` usually arrives as a JS array, but for queries
 * buried inside subqueries some pg versions hand it back as the native
 * text form `{a,b,c}`. MySQL/MSSQL drivers tend to hand it back comma-joined.
 * Making this defensive keeps renderers simple.
 */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v == null) return [];
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      // Postgres text array notation — split on commas not inside quotes.
      return trimmed
        .slice(1, -1)
        .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map((s) => s.replace(/^"|"$/g, ''))
        .filter(Boolean);
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [String(v)];
}

function normalizeFk(fk: ForeignKeyMeta): ForeignKeyMeta {
  return {
    ...fk,
    columns: toStringArray(fk.columns),
    refColumns: toStringArray(fk.refColumns),
  };
}

/** Group FKs by their owning (schema, table). */
function fksByTable(fks: ForeignKeyMeta[]): Map<string, ForeignKeyMeta[]> {
  const map = new Map<string, ForeignKeyMeta[]>();
  for (const fk of fks) {
    const key = `${fk.schema}.${fk.table}`;
    const list = map.get(key) ?? [];
    list.push(fk);
    map.set(key, list);
  }
  return map;
}

// ---- Prisma renderer -----------------------------------------------------

function prismaScalar(column: ColumnMeta, dialect: Dialect): string {
  const t = column.dataType.toLowerCase();
  // Cheap dialect-agnostic mapping. Unknown types fall back to String with a
  // comment so the user can adjust.
  if (/\b(bigint|int8)\b/.test(t)) return 'BigInt';
  if (/\b(smallint|int2|int4|integer|int|mediumint|tinyint|serial)\b/.test(t)) return 'Int';
  if (/\b(numeric|decimal)\b/.test(t)) return 'Decimal';
  if (/\b(real|double|float)\b/.test(t)) return 'Float';
  if (/\bbool/.test(t)) return 'Boolean';
  if (/\b(timestamp|datetime|timestamptz)\b/.test(t)) return 'DateTime';
  if (/\bdate\b/.test(t)) return 'DateTime';
  if (/\btime\b/.test(t)) return 'DateTime';
  if (/\bjson/.test(t)) return 'Json';
  if (/\buuid\b/.test(t)) return 'String';
  if (/\bbytea|blob|binary\b/.test(t)) return 'Bytes';
  if (/\b(text|varchar|char|citext)\b/.test(t)) return 'String';
  return 'String';
}

function prismaProvider(dialect: Dialect): string {
  switch (dialect) {
    case Dialect.POSTGRES:
      return 'postgresql';
    case Dialect.MYSQL:
      return 'mysql';
    case Dialect.SQLITE:
      return 'sqlite';
    case Dialect.MSSQL:
      return 'sqlserver';
  }
}

function renderPrisma(er: ErDiagram, dialect: Dialect): string {
  const fkMap = fksByTable(er.foreignKeys);
  const lines: string[] = [];
  lines.push('// Generated by Query Schema — tune by hand as needed.');
  lines.push('// This is a snapshot of the current DB schema, not a diff.');
  lines.push('');
  lines.push('generator client {');
  lines.push('  provider = "prisma-client-js"');
  lines.push('}');
  lines.push('');
  lines.push('datasource db {');
  lines.push(`  provider = "${prismaProvider(dialect)}"`);
  lines.push('  url      = env("DATABASE_URL")');
  lines.push('}');
  lines.push('');

  // Build a quick lookup: for reverse-relation field placement we need
  // (refSchema.refTable) → [{ sourceTable, sourceColumns }]
  const inbound = new Map<string, { sourceTable: string; fkName: string }[]>();
  for (const fk of er.foreignKeys) {
    const key = `${fk.refSchema}.${fk.refTable}`;
    const list = inbound.get(key) ?? [];
    list.push({ sourceTable: fk.table, fkName: fk.name });
    inbound.set(key, list);
  }

  for (const t of er.tables) {
    const modelName = pascalCase(t.name);
    lines.push(`model ${modelName} {`);
    const pkCols = t.columns.filter((c) => c.isPrimaryKey);
    const tableFks = fkMap.get(`${t.schema}.${t.name}`) ?? [];
    const fkColSet = new Set(tableFks.flatMap((fk) => fk.columns));

    for (const c of t.columns) {
      const parts: string[] = [];
      parts.push(`  ${c.name}`);
      const scalar = prismaScalar(c, dialect);
      const optional = c.nullable ? '?' : '';
      parts.push(`${scalar}${optional}`);
      const modifiers: string[] = [];
      if (c.isPrimaryKey && pkCols.length === 1) modifiers.push('@id');
      if (c.isUnique && !c.isPrimaryKey) modifiers.push('@unique');
      if (c.isIdentity || /\bserial\b/i.test(c.dataType)) modifiers.push('@default(autoincrement())');
      if (c.defaultValue && !c.isIdentity) {
        const def = String(c.defaultValue).trim();
        if (/^(NULL)$/i.test(def)) {
          // skip
        } else if (/^(CURRENT_TIMESTAMP|now\(\))/i.test(def)) {
          modifiers.push('@default(now())');
        } else if (/^(TRUE|FALSE)$/i.test(def)) {
          modifiers.push(`@default(${def.toLowerCase()})`);
        } else if (/^-?\d+(\.\d+)?$/.test(def)) {
          modifiers.push(`@default(${def})`);
        } else if (/^'.*'::/i.test(def) || /^'.*'$/.test(def)) {
          // '...'::type style — extract the inner string.
          const m = def.match(/^'((?:[^']|'')*)'/);
          if (m) modifiers.push(`@default("${m[1].replace(/"/g, '\\"')}")`);
        }
      }
      if (modifiers.length) parts.push(modifiers.join(' '));
      lines.push(parts.join(' '));
    }

    // Composite PK
    if (pkCols.length > 1) {
      lines.push(`  @@id([${pkCols.map((c) => c.name).join(', ')}])`);
    }

    // Outgoing FKs → relation fields + @relation(fields:..., references:...)
    for (const fk of tableFks) {
      const refModel = pascalCase(fk.refTable);
      const fieldName = camelCase(fk.refTable);
      // Naive — if the relation field name collides with a scalar column, skip.
      const collides = t.columns.some((c) => c.name === fieldName);
      if (collides) continue;
      lines.push(
        `  ${fieldName} ${refModel}${fk.columns.some((col) => t.columns.find((c) => c.name === col)?.nullable) ? '?' : ''} ` +
          `@relation(fields: [${fk.columns.join(', ')}], references: [${fk.refColumns.join(', ')}])`,
      );
    }

    // Inbound relations → add a reverse field with a list type.
    const incoming = inbound.get(`${t.schema}.${t.name}`) ?? [];
    for (const inc of incoming) {
      const fieldName = camelCase(inc.sourceTable) + 's';
      const collides = t.columns.some((c) => c.name === fieldName);
      if (collides) continue;
      lines.push(`  ${fieldName} ${pascalCase(inc.sourceTable)}[]`);
    }

    // @@map for snake_case tables
    if (t.name !== modelName) {
      lines.push(`  @@map("${t.name}")`);
    }

    lines.push('}');
    lines.push('');

    // Mark unused for linter — fkColSet referenced above; suppress TS noise.
    void fkColSet;
  }

  return lines.join('\n');
}

// ---- Drizzle renderer ----------------------------------------------------

function drizzleImport(dialect: Dialect): { pkg: string; table: string; types: string[] } {
  const common = ['text', 'integer', 'boolean', 'timestamp', 'decimal', 'doublePrecision', 'bigint', 'uuid', 'json', 'jsonb'];
  switch (dialect) {
    case Dialect.POSTGRES:
      return { pkg: 'drizzle-orm/pg-core', table: 'pgTable', types: common };
    case Dialect.MYSQL:
      return { pkg: 'drizzle-orm/mysql-core', table: 'mysqlTable', types: ['varchar', 'text', 'int', 'bigint', 'boolean', 'timestamp', 'decimal', 'double', 'json'] };
    case Dialect.SQLITE:
      return { pkg: 'drizzle-orm/sqlite-core', table: 'sqliteTable', types: ['text', 'integer', 'real', 'blob'] };
    case Dialect.MSSQL:
      throw new BadRequestException('Drizzle does not yet support SQL Server in this export');
  }
}

function drizzleType(column: ColumnMeta, dialect: Dialect): string {
  const t = column.dataType.toLowerCase();
  const col = `"${column.name}"`;
  if (dialect === Dialect.POSTGRES) {
    if (/\buuid\b/.test(t)) return `uuid(${col})`;
    if (/\b(bigint|int8)\b/.test(t)) return `bigint(${col}, { mode: 'number' })`;
    if (/\b(smallint|int2|int4|integer|int|serial)\b/.test(t)) return `integer(${col})`;
    if (/\bjsonb\b/.test(t)) return `jsonb(${col})`;
    if (/\bjson\b/.test(t)) return `json(${col})`;
    if (/\b(numeric|decimal)\b/.test(t)) return `decimal(${col})`;
    if (/\b(real|double|float)\b/.test(t)) return `doublePrecision(${col})`;
    if (/\bbool/.test(t)) return `boolean(${col})`;
    if (/\btimestamptz\b/.test(t)) return `timestamp(${col}, { withTimezone: true })`;
    if (/\btimestamp\b/.test(t)) return `timestamp(${col})`;
    if (/\b(text|varchar|char|citext)\b/.test(t)) return `text(${col})`;
    return `text(${col})`;
  }
  if (dialect === Dialect.MYSQL) {
    if (/\b(bigint)\b/.test(t)) return `bigint(${col}, { mode: 'number' })`;
    if (/\b(smallint|int|integer|mediumint|tinyint)\b/.test(t)) return `int(${col})`;
    if (/\b(decimal|numeric)\b/.test(t)) return `decimal(${col})`;
    if (/\b(double|float|real)\b/.test(t)) return `double(${col})`;
    if (/\bbool|tinyint\(1\)/.test(t)) return `boolean(${col})`;
    if (/\btimestamp|datetime\b/.test(t)) return `timestamp(${col})`;
    if (/\bjson\b/.test(t)) return `json(${col})`;
    if (/\b(varchar|char)\b/.test(t)) {
      const len = column.charMaxLength ?? 255;
      return `varchar(${col}, { length: ${len} })`;
    }
    return `text(${col})`;
  }
  // SQLite
  if (/\b(int|integer)\b/.test(t)) return `integer(${col})`;
  if (/\b(real|double|float|numeric|decimal)\b/.test(t)) return `real(${col})`;
  if (/\bblob\b/.test(t)) return `blob(${col})`;
  return `text(${col})`;
}

function renderDrizzle(er: ErDiagram, dialect: Dialect): string {
  const imp = drizzleImport(dialect);
  const fkMap = fksByTable(er.foreignKeys);

  const lines: string[] = [];
  lines.push(`// Generated by Query Schema — snapshot of current DB schema.`);
  lines.push(`import { ${imp.table}, ${imp.types.join(', ')} } from '${imp.pkg}';`);
  lines.push('');

  for (const t of er.tables) {
    const modelName = camelCase(t.name);
    lines.push(`export const ${modelName} = ${imp.table}('${t.name}', {`);
    for (const c of t.columns) {
      let line = `  ${camelCase(c.name)}: ${drizzleType(c, dialect)}`;
      const mods: string[] = [];
      if (c.isPrimaryKey) mods.push('.primaryKey()');
      if (!c.nullable && !c.isPrimaryKey) mods.push('.notNull()');
      if (c.isUnique && !c.isPrimaryKey) mods.push('.unique()');
      line += mods.join('') + ',';
      lines.push(line);
    }
    const fks = fkMap.get(`${t.schema}.${t.name}`) ?? [];
    for (const fk of fks) {
      const refModel = camelCase(fk.refTable);
      lines.push(
        `  // FK: ${fk.columns.join(', ')} -> ${fk.refTable}(${fk.refColumns.join(', ')}) — wire with relations() for ${refModel}`,
      );
    }
    lines.push('});');
    lines.push('');
  }
  return lines.join('\n');
}

// ---- Raw SQL renderer ----------------------------------------------------

function sqlType(column: ColumnMeta, dialect: Dialect): string {
  // Keep the original type string the driver gave us — it already reflects the
  // source DB's native grammar. Small cleanup for consistency.
  let t = column.dataType.trim();
  if (dialect === Dialect.SQLITE && !t) t = 'TEXT';
  return t;
}

function sqlIdent(name: string, dialect: Dialect): string {
  if (dialect === Dialect.MYSQL) return `\`${name.replace(/`/g, '``')}\``;
  if (dialect === Dialect.MSSQL) return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function renderSql(er: ErDiagram, dialect: Dialect): string {
  const lines: string[] = [];
  lines.push(`-- Schema snapshot generated by Query Schema.`);
  lines.push(`-- Dialect: ${dialect}`);
  lines.push('');

  for (const t of er.tables) {
    const qualified =
      dialect === Dialect.SQLITE
        ? sqlIdent(t.name, dialect)
        : `${sqlIdent(t.schema, dialect)}.${sqlIdent(t.name, dialect)}`;
    lines.push(`CREATE TABLE ${qualified} (`);
    const colLines = t.columns.map((c) => {
      const parts: string[] = [];
      parts.push(`  ${sqlIdent(c.name, dialect)} ${sqlType(c, dialect)}`);
      if (!c.nullable) parts.push('NOT NULL');
      if (c.defaultValue !== null && c.defaultValue !== undefined) {
        parts.push(`DEFAULT ${c.defaultValue}`);
      }
      return parts.join(' ');
    });
    const pks = t.columns.filter((c) => c.isPrimaryKey).map((c) => sqlIdent(c.name, dialect));
    if (pks.length > 0) {
      colLines.push(`  PRIMARY KEY (${pks.join(', ')})`);
    }
    lines.push(colLines.join(',\n'));
    lines.push(');');
    lines.push('');
  }

  for (const fk of er.foreignKeys) {
    const from =
      dialect === Dialect.SQLITE
        ? sqlIdent(fk.table, dialect)
        : `${sqlIdent(fk.schema, dialect)}.${sqlIdent(fk.table, dialect)}`;
    const to =
      dialect === Dialect.SQLITE
        ? sqlIdent(fk.refTable, dialect)
        : `${sqlIdent(fk.refSchema, dialect)}.${sqlIdent(fk.refTable, dialect)}`;
    lines.push(
      `ALTER TABLE ${from} ADD CONSTRAINT ${sqlIdent(fk.name, dialect)} ` +
        `FOREIGN KEY (${fk.columns.map((c) => sqlIdent(c, dialect)).join(', ')}) ` +
        `REFERENCES ${to} (${fk.refColumns.map((c) => sqlIdent(c, dialect)).join(', ')})` +
        (fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
        (fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '') +
        `;`,
    );
  }

  return lines.join('\n');
}
