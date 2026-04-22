import { Dialect } from '@prisma/client';

export interface SshTunnelConfig {
  host: string;
  port: number;
  user: string;
  authType: 'password' | 'privateKey';
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface ConnectionCredentials {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  filename?: string; // sqlite
  sslMode?: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  ssh?: SshTunnelConfig;
  extra?: Record<string, unknown>;
}

export interface DriverOptions {
  readOnly?: boolean;
  statementTimeoutMs?: number;
}

export interface ColumnMeta {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isIdentity: boolean;
  comment?: string | null;
  charMaxLength?: number | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
}

export interface ForeignKeyMeta {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface IndexMeta {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  method?: string;
}

export interface TableRef {
  schema: string;
  name: string;
  type: 'table' | 'view' | 'materialized_view';
  comment?: string | null;
  estimatedRows?: number | null;
}

export interface FunctionMeta {
  schema: string;
  name: string;
  language?: string;
  returnType?: string;
  arguments?: string;
}

export interface TriggerMeta {
  schema: string;
  table: string;
  name: string;
  timing?: string;
  event?: string;
  statement?: string;
}

export interface TableDataQuery {
  schema: string;
  table: string;
  limit: number;
  offset: number;
  orderBy?: { column: string; direction: 'asc' | 'desc' }[];
  filters?: { column: string; op: string; value: unknown }[];
}

export interface TableDataResult {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  /** Row count matching filters. `null` means "unknown / too expensive" — UI should show e.g. "many". */
  total: number | null;
  /** When true, `total` is a planner estimate (e.g. pg_class.reltuples), not an exact count. */
  totalIsEstimate?: boolean;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  fields: { name: string; dataType?: string }[];
  rowCount: number;
  command?: string;
  durationMs: number;
}

export interface ErDiagram {
  tables: { schema: string; name: string; columns: ColumnMeta[] }[];
  foreignKeys: ForeignKeyMeta[];
}

export interface IDatabaseDriver {
  readonly dialect: Dialect;
  testConnection(): Promise<{ ok: boolean; version?: string; error?: string }>;
  listSchemas(): Promise<string[]>;
  listTables(schema?: string): Promise<TableRef[]>;
  getTableColumns(schema: string, table: string): Promise<ColumnMeta[]>;
  getTableDefinition?(schema: string, table: string): Promise<string>;
  getTableData(q: TableDataQuery): Promise<TableDataResult>;
  insertRow(schema: string, table: string, values: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateRow(
    schema: string,
    table: string,
    pk: Record<string, unknown>,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  deleteRow(schema: string, table: string, pk: Record<string, unknown>): Promise<number>;
  deleteRows?(schema: string, table: string, pks: Record<string, unknown>[]): Promise<number>;
  /** Fetch a single row identified by its PK, or null if not found. Used by the audit
   *  layer to snapshot "before" state for revertable change history. */
  fetchRowByPk?(
    schema: string,
    table: string,
    pk: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  /** Fetch multiple rows by PK for bulk ops' before-state snapshots. */
  fetchRowsByPks?(
    schema: string,
    table: string,
    pks: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]>;
  /** Apply the same set of column values to every row whose PK matches. */
  bulkUpdateRows?(
    schema: string,
    table: string,
    pks: Record<string, unknown>[],
    values: Record<string, unknown>,
  ): Promise<number>;
  runRawQuery(sql: string, params?: unknown[]): Promise<QueryResult>;
  introspectForER(schema?: string): Promise<ErDiagram>;
  listFunctions(schema?: string): Promise<FunctionMeta[]>;
  listTriggers(schema?: string): Promise<TriggerMeta[]>;
  listIndexes(schema?: string, table?: string): Promise<IndexMeta[]>;
  createTable(ddl: CreateTableSpec, execute: boolean): Promise<{ sql: string; executed: boolean }>;
  alterTable(ddl: AlterTableSpec, execute: boolean): Promise<{ sql: string; executed: boolean }>;
  dropTable(schema: string, table: string, execute: boolean): Promise<{ sql: string; executed: boolean }>;
  close(): Promise<void>;
}

export interface ColumnSpec {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string | null;
  /** When true, wraps `default` in parentheses — treated as an expression rather than a literal. */
  defaultIsExpression?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  check?: string | null;
  comment?: string | null;
}

export interface ForeignKeySpec {
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface CreateTableSpec {
  schema: string;
  name: string;
  columns: ColumnSpec[];
  foreignKeys?: ForeignKeySpec[];
}

export interface AlterTableSpec {
  schema: string;
  name: string;
  addColumns?: ColumnSpec[];
  dropColumns?: string[];
  renameColumns?: { from: string; to: string }[];
  alterColumns?: { name: string; type?: string; nullable?: boolean; default?: string | null; check?: string | null; comment?: string | null }[];
  addForeignKeys?: ForeignKeySpec[];
  dropConstraints?: string[];
  renameTo?: string;
}
