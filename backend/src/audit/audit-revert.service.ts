import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { AuditService } from './audit.service';

interface RowAuditMetadata {
  schema?: string;
  tableName?: string;
  pk?: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  beforeRows?: Record<string, unknown>[];
  afterValues?: Record<string, unknown>;
  bulk?: number;
}

export interface RevertPreview {
  kind: 'insert' | 'update' | 'delete' | 'bulk-update' | 'bulk-delete';
  description: string;
  rowCount: number;
}

@Injectable()
export class AuditRevertService {
  constructor(
    private readonly audit: AuditService,
    private readonly connections: ConnectionsService,
  ) {}

  /** Load + validate an entry. Returns audit + parsed metadata. */
  private async loadEntry(entryId: string, connectionId: string) {
    const entry = await this.audit.findById(entryId);
    if (!entry || entry.connectionId !== connectionId) {
      throw new NotFoundException('Audit entry not found');
    }
    const metadata = (entry.metadata ?? {}) as RowAuditMetadata;
    return { entry, metadata };
  }

  preview(entry: { action: string }, metadata: RowAuditMetadata): RevertPreview {
    const action = entry.action;
    const tableRef = metadata.schema && metadata.tableName
      ? `${metadata.schema}.${metadata.tableName}`
      : 'unknown table';

    if (metadata.bulk && metadata.beforeRows) {
      if (action === 'ROW_DELETE') {
        return {
          kind: 'bulk-delete',
          description: `Restore ${metadata.beforeRows.length} deleted row(s) in ${tableRef}`,
          rowCount: metadata.beforeRows.length,
        };
      }
      if (action === 'ROW_UPDATE') {
        return {
          kind: 'bulk-update',
          description: `Revert ${metadata.beforeRows.length} updated row(s) in ${tableRef}`,
          rowCount: metadata.beforeRows.length,
        };
      }
    }
    if (action === 'ROW_INSERT' && metadata.after) {
      return { kind: 'delete', description: `Delete the inserted row in ${tableRef}`, rowCount: 1 };
    }
    if (action === 'ROW_UPDATE' && metadata.before && metadata.pk) {
      return { kind: 'update', description: `Revert the update in ${tableRef}`, rowCount: 1 };
    }
    if (action === 'ROW_DELETE' && metadata.before) {
      return { kind: 'insert', description: `Re-insert the deleted row in ${tableRef}`, rowCount: 1 };
    }
    throw new BadRequestException('This audit entry is not revertable (missing snapshot data).');
  }

  async buildPreview(entryId: string, connectionId: string): Promise<RevertPreview> {
    const { entry, metadata } = await this.loadEntry(entryId, connectionId);
    return this.preview(entry, metadata);
  }

  async revert(entryId: string, connectionId: string, userId: string, requestMeta: { ip?: string; userAgent?: string }) {
    const { entry, metadata } = await this.loadEntry(entryId, connectionId);
    const schema = metadata.schema;
    const tableName = metadata.tableName;
    if (!schema || !tableName) {
      throw new BadRequestException('Audit entry predates revert support and cannot be reverted.');
    }
    // Pick the primary-key columns of the target row from the before/after snapshot.
    const pickPk = (sample: Record<string, unknown>, keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = sample[k];
      return out;
    };

    // Use an EDITOR-role driver for the revert — VIEWER can't mutate, OWNER is overkill.
    const drv = await this.connections.buildDriverForRole(connectionId, Role.EDITOR);
    try {
      let affected = 0;
      let revertAction: 'ROW_INSERT' | 'ROW_UPDATE' | 'ROW_DELETE' = 'ROW_UPDATE';

      if (metadata.bulk && metadata.beforeRows && entry.action === 'ROW_DELETE') {
        // Bulk delete reverted: re-insert every snapshot.
        for (const row of metadata.beforeRows) {
          await drv.insertRow(schema, tableName, row);
          affected++;
        }
        revertAction = 'ROW_INSERT';
      } else if (metadata.bulk && metadata.beforeRows && entry.action === 'ROW_UPDATE') {
        // Bulk update reverted: restore each row individually. We need to know the PK columns;
        // derive them from the first snapshot's keys that match the table's PK via introspection.
        const cols = await drv.getTableColumns(schema, tableName);
        const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
        if (!pkCols.length) throw new BadRequestException('Table has no primary key — cannot revert.');
        for (const row of metadata.beforeRows) {
          const pk = pickPk(row, pkCols);
          const values: Record<string, unknown> = { ...row };
          for (const k of pkCols) delete values[k];
          await drv.updateRow(schema, tableName, pk, values);
          affected++;
        }
      } else if (entry.action === 'ROW_INSERT' && metadata.after) {
        // Revert an insert: delete by PK.
        const cols = await drv.getTableColumns(schema, tableName);
        const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
        if (!pkCols.length) throw new BadRequestException('Table has no primary key — cannot revert.');
        const pk = pickPk(metadata.after, pkCols);
        affected = await drv.deleteRow(schema, tableName, pk);
        revertAction = 'ROW_DELETE';
      } else if (entry.action === 'ROW_UPDATE' && metadata.before && metadata.pk) {
        // Revert a single update: set everything back to `before`.
        const values: Record<string, unknown> = { ...metadata.before };
        for (const k of Object.keys(metadata.pk)) delete values[k];
        await drv.updateRow(schema, tableName, metadata.pk, values);
        affected = 1;
      } else if (entry.action === 'ROW_DELETE' && metadata.before) {
        // Revert a single delete: re-insert.
        await drv.insertRow(schema, tableName, metadata.before);
        affected = 1;
        revertAction = 'ROW_INSERT';
      } else {
        throw new BadRequestException('This audit entry is not revertable.');
      }

      await this.audit.log({
        userId,
        connectionId,
        action: revertAction,
        affectedRows: affected,
        ...requestMeta,
        metadata: {
          table: `${schema}.${tableName}`,
          schema,
          tableName,
          revertedFrom: entry.id,
          bulk: metadata.bulk,
        },
      });
      return { affected };
    } finally {
      await drv.close().catch(() => {});
    }
  }
}
