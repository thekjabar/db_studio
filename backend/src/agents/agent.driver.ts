import { Dialect } from '@prisma/client';
import {
  IDatabaseDriver, ConnectionCredentials, DriverOptions, ColumnMeta, ForeignKeyMeta,
  IndexMeta, TableRef, FunctionMeta, TriggerMeta, TableDataQuery, TableDataResult,
  QueryResult, ErDiagram, CreateTableSpec, AlterTableSpec,
} from '../drivers/driver.interface';
import { AgentRelayService } from './agent-relay.service';

/**
 * An IDatabaseDriver that executes every operation on a remote network agent
 * via the relay, instead of opening a local DB connection. The agent runs the
 * real driver (same drivers package) against the database inside the customer's
 * network and returns results over the WebSocket.
 *
 * Because this implements the same interface, the entire query pipeline —
 * RBAC, column masking, audit, slow-query, cache, plan-regression, cursor
 * wrapping — works unchanged; only the physical execution location differs.
 *
 * The cloud passes the decrypted credentials to the agent on the FIRST call so
 * the agent can build its local driver; subsequent calls reuse the agent's
 * cached driver keyed by connectionId. Credentials travel only over the
 * TLS-secured, token-authenticated relay.
 */
export class AgentDriver implements IDatabaseDriver {
  readonly dialect: Dialect;

  constructor(
    private readonly relay: AgentRelayService,
    private readonly agentId: string,
    private readonly connectionId: string,
    private readonly creds: ConnectionCredentials,
    dialect: Dialect,
    private readonly opts: DriverOptions,
  ) {
    this.dialect = dialect;
  }

  /** Relay a driver method to the agent. The agent is given everything it
   *  needs to build/reuse the local driver: connectionId, creds, dialect, opts. */
  private call<T>(method: string, args: unknown[]): Promise<T> {
    return this.relay.rpc<T>(this.agentId, 'driver', [
      {
        connectionId: this.connectionId,
        dialect: this.dialect,
        creds: this.creds,
        opts: this.opts,
        method,
        args,
      },
    ]);
  }

  testConnection() {
    return this.call<{ ok: boolean; version?: string; error?: string }>('testConnection', []);
  }
  listSchemas() {
    return this.call<string[]>('listSchemas', []);
  }
  listTables(schema?: string) {
    return this.call<TableRef[]>('listTables', [schema]);
  }
  getTableColumns(schema: string, table: string) {
    return this.call<ColumnMeta[]>('getTableColumns', [schema, table]);
  }
  getTableDefinition(schema: string, table: string) {
    return this.call<string>('getTableDefinition', [schema, table]);
  }
  getTableData(q: TableDataQuery) {
    return this.call<TableDataResult>('getTableData', [q]);
  }
  insertRow(schema: string, table: string, values: Record<string, unknown>) {
    return this.call<Record<string, unknown>>('insertRow', [schema, table, values]);
  }
  updateRow(schema: string, table: string, pk: Record<string, unknown>, values: Record<string, unknown>) {
    return this.call<Record<string, unknown>>('updateRow', [schema, table, pk, values]);
  }
  deleteRow(schema: string, table: string, pk: Record<string, unknown>) {
    return this.call<number>('deleteRow', [schema, table, pk]);
  }
  deleteRows(schema: string, table: string, pks: Record<string, unknown>[]) {
    return this.call<number>('deleteRows', [schema, table, pks]);
  }
  fetchRowByPk(schema: string, table: string, pk: Record<string, unknown>) {
    return this.call<Record<string, unknown> | null>('fetchRowByPk', [schema, table, pk]);
  }
  fetchRowsByPks(schema: string, table: string, pks: Record<string, unknown>[]) {
    return this.call<Record<string, unknown>[]>('fetchRowsByPks', [schema, table, pks]);
  }
  bulkUpdateRows(schema: string, table: string, pks: Record<string, unknown>[], values: Record<string, unknown>) {
    return this.call<number>('bulkUpdateRows', [schema, table, pks, values]);
  }
  runRawQuery(sql: string, params?: unknown[], opts?: { searchPath?: string }) {
    return this.call<QueryResult>('runRawQuery', [sql, params, opts]);
  }
  introspectForER(schema?: string) {
    return this.call<ErDiagram>('introspectForER', [schema]);
  }
  listFunctions(schema?: string) {
    return this.call<FunctionMeta[]>('listFunctions', [schema]);
  }
  listTriggers(schema?: string) {
    return this.call<TriggerMeta[]>('listTriggers', [schema]);
  }
  listIndexes(schema?: string, table?: string) {
    return this.call<IndexMeta[]>('listIndexes', [schema, table]);
  }
  createTable(ddl: CreateTableSpec, execute: boolean) {
    return this.call<{ sql: string; executed: boolean }>('createTable', [ddl, execute]);
  }
  alterTable(ddl: AlterTableSpec, execute: boolean) {
    return this.call<{ sql: string; executed: boolean }>('alterTable', [ddl, execute]);
  }
  dropTable(schema: string, table: string, execute: boolean) {
    return this.call<{ sql: string; executed: boolean }>('dropTable', [schema, table, execute]);
  }
  // Foreign-key meta isn't part of the interface's required methods used here,
  // but ER + indexes cover introspection. No persistent resources to close —
  // the agent owns the real driver lifecycle.
  async close() {
    /* no-op: the cloud holds no DB handle; the agent pools its own driver. */
  }

  // Satisfy the optional ForeignKeyMeta typing import usage.
  // (Kept to avoid unused-import noise; ForeignKeyMeta is part of ErDiagram.)
  private _fk?: ForeignKeyMeta;
}
