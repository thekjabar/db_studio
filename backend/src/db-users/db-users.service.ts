import { BadRequestException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { AuditService } from '../audit/audit.service';
import { quotePg, assertIdentShape } from '../drivers/quote.util';
import {
  AlterDbUserDto, CreateDbUserDto, GrantDto, MembershipDto, RevokeDto,
} from './db-users.dto';

/**
 * Manage *database-level* roles/users on a connected Postgres server: create,
 * alter, drop, list, and grant/revoke privileges. This operates on the user's
 * target database (via the same driver layer as the query runner), NOT on DB
 * Studio's own accounts. All actions require connection OWNER and are audited.
 *
 * Safety model:
 *   - This is Postgres-only (role DDL syntax differs per engine); other dialects
 *     are rejected with a clear message.
 *   - All identifiers go through quotePg() (shape-checked + double-quoted).
 *   - Passwords are passed as bound parameters wherever the statement allows it;
 *     CREATE/ALTER ROLE ... PASSWORD does not accept bind params, so the password
 *     is escaped as a single-quoted literal (we never interpolate it raw).
 *   - Privilege keywords are whitelisted against a fixed set per level.
 */
@Injectable()
export class DbUsersService {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly audit: AuditService,
  ) {}

  private async assertPostgres(connectionId: string): Promise<void> {
    const conn = await this.connections.get(connectionId);
    if (conn.dialect !== 'POSTGRES') {
      throw new BadRequestException(
        'Database user management is currently supported for PostgreSQL connections only.',
      );
    }
  }

  /** Owner-scoped driver bound to this connection. */
  private async driver(connectionId: string) {
    return this.connections.buildDriverForRole(connectionId, Role.OWNER);
  }

  // ---- Read ----

  /** List all roles with their attributes (login users + group roles). */
  async listUsers(connectionId: string) {
    await this.assertPostgres(connectionId);
    const drv = await this.driver(connectionId);
    try {
      const res = await drv.runRawQuery(`
        SELECT
          r.rolname                                   AS name,
          r.rolsuper                                  AS superuser,
          r.rolcanlogin                               AS can_login,
          r.rolcreatedb                               AS create_db,
          r.rolcreaterole                             AS create_role,
          r.rolinherit                                AS inherit,
          r.rolreplication                            AS replication,
          r.rolconnlimit                              AS connection_limit,
          r.rolvaliduntil                             AS valid_until,
          ARRAY(
            SELECT g.rolname FROM pg_auth_members m
            JOIN pg_roles g ON g.oid = m.roleid
            WHERE m.member = r.oid
            ORDER BY g.rolname
          )                                           AS member_of
        FROM pg_roles r
        WHERE r.rolname NOT LIKE 'pg\\_%'
        ORDER BY r.rolcanlogin DESC, r.rolname
      `);
      return res.rows;
    } finally {
      await drv.close().catch(() => {});
    }
  }

  /** Privilege grants visible for a role: database, schema, and table level. */
  async getUserPrivileges(connectionId: string, roleName: string) {
    await this.assertPostgres(connectionId);
    assertIdentShape(roleName);
    const drv = await this.driver(connectionId);
    try {
      // Database-level privileges (CONNECT/CREATE/TEMP) for the current database.
      const dbPriv = await drv.runRawQuery(
        `SELECT d.datname AS database, p.privilege_type
           FROM pg_database d
           CROSS JOIN LATERAL (
             SELECT unnest(ARRAY['CONNECT','CREATE','TEMPORARY']) AS privilege_type
           ) p
          WHERE d.datname = current_database()
            AND has_database_privilege($1, d.datname, p.privilege_type)`,
        [roleName],
      );
      // Schema-level USAGE/CREATE on non-system schemas.
      const schemaPriv = await drv.runRawQuery(
        `SELECT n.nspname AS schema, p.privilege_type
           FROM pg_namespace n
           CROSS JOIN LATERAL (
             SELECT unnest(ARRAY['USAGE','CREATE']) AS privilege_type
           ) p
          WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
            AND has_schema_privilege($1, n.nspname, p.privilege_type)
          ORDER BY n.nspname`,
        [roleName],
      );
      // Table-level grants from information_schema (already per-grantee).
      const tablePriv = await drv.runRawQuery(
        `SELECT table_schema AS schema, table_name AS table, privilege_type, is_grantable
           FROM information_schema.role_table_grants
          WHERE grantee = $1
            AND table_schema NOT LIKE 'pg\\_%' AND table_schema <> 'information_schema'
          ORDER BY table_schema, table_name, privilege_type`,
        [roleName],
      );
      return {
        database: dbPriv.rows,
        schema: schemaPriv.rows,
        table: tablePriv.rows,
      };
    } finally {
      await drv.close().catch(() => {});
    }
  }

  // ---- Mutations ----

  async createUser(connectionId: string, dto: CreateDbUserDto, userId: string, meta: AuditMeta) {
    await this.assertPostgres(connectionId);
    const name = quotePg(dto.name);
    const opts: string[] = [];
    opts.push(dto.login === false ? 'NOLOGIN' : 'LOGIN');
    if (dto.superuser) opts.push('SUPERUSER');
    if (dto.createDb) opts.push('CREATEDB');
    if (dto.createRole) opts.push('CREATEROLE');
    if (dto.inherit === false) opts.push('NOINHERIT');
    if (typeof dto.connectionLimit === 'number') {
      opts.push(`CONNECTION LIMIT ${Math.trunc(dto.connectionLimit)}`);
    }
    if (dto.password) opts.push(`PASSWORD ${literal(dto.password)}`);
    if (dto.validUntil) opts.push(`VALID UNTIL ${literal(dto.validUntil)}`);

    const sql = `CREATE ROLE ${name} ${opts.join(' ')}`;
    const drv = await this.driver(connectionId);
    try {
      await drv.runRawQuery(sql);
    } finally {
      await drv.close().catch(() => {});
    }
    await this.audit.log({
      userId, connectionId, action: 'SCHEMA_CHANGE',
      sqlText: redactPassword(sql), ...meta,
      metadata: { feature: 'db-users', op: 'create', role: dto.name },
    });
    return { ok: true };
  }

  async alterUser(connectionId: string, roleName: string, dto: AlterDbUserDto, userId: string, meta: AuditMeta) {
    await this.assertPostgres(connectionId);
    const name = quotePg(roleName);
    const opts: string[] = [];
    if (dto.login === true) opts.push('LOGIN');
    if (dto.login === false) opts.push('NOLOGIN');
    if (dto.superuser === true) opts.push('SUPERUSER');
    if (dto.superuser === false) opts.push('NOSUPERUSER');
    if (dto.createDb === true) opts.push('CREATEDB');
    if (dto.createDb === false) opts.push('NOCREATEDB');
    if (dto.createRole === true) opts.push('CREATEROLE');
    if (dto.createRole === false) opts.push('NOCREATEROLE');
    if (typeof dto.connectionLimit === 'number') {
      opts.push(`CONNECTION LIMIT ${Math.trunc(dto.connectionLimit)}`);
    }
    if (dto.password) opts.push(`PASSWORD ${literal(dto.password)}`);
    if (dto.validUntil !== undefined) {
      opts.push(dto.validUntil === '' ? `VALID UNTIL 'infinity'` : `VALID UNTIL ${literal(dto.validUntil)}`);
    }
    if (opts.length === 0) throw new BadRequestException('No changes specified');

    const sql = `ALTER ROLE ${name} ${opts.join(' ')}`;
    const drv = await this.driver(connectionId);
    try {
      await drv.runRawQuery(sql);
    } finally {
      await drv.close().catch(() => {});
    }
    await this.audit.log({
      userId, connectionId, action: 'SCHEMA_CHANGE',
      sqlText: redactPassword(sql), ...meta,
      metadata: { feature: 'db-users', op: 'alter', role: roleName },
    });
    return { ok: true };
  }

  async dropUser(connectionId: string, roleName: string, userId: string, meta: AuditMeta) {
    await this.assertPostgres(connectionId);
    const name = quotePg(roleName);
    const sql = `DROP ROLE IF EXISTS ${name}`;
    const drv = await this.driver(connectionId);
    try {
      await drv.runRawQuery(sql);
    } finally {
      await drv.close().catch(() => {});
    }
    await this.audit.log({
      userId, connectionId, action: 'SCHEMA_CHANGE',
      sqlText: sql, ...meta,
      metadata: { feature: 'db-users', op: 'drop', role: roleName },
    });
    return { ok: true };
  }

  async grant(connectionId: string, dto: GrantDto, userId: string, meta: AuditMeta) {
    return this.grantOrRevoke('grant', connectionId, dto, userId, meta);
  }
  async revoke(connectionId: string, dto: RevokeDto, userId: string, meta: AuditMeta) {
    return this.grantOrRevoke('revoke', connectionId, dto, userId, meta);
  }

  private async grantOrRevoke(kind: 'grant' | 'revoke', connectionId: string, dto: GrantDto, userId: string, meta: AuditMeta) {
    await this.assertPostgres(connectionId);
    const role = quotePg(dto.role);
    const privs = normalizePrivileges(dto.level, dto.privileges);

    let target: string;
    if (dto.level === 'database') {
      // GRANT's target needs a literal db name (current_database() isn't valid
      // there), so resolve it; scoping to the connected DB keeps this safe.
      target = `DATABASE ${quotePg(await this.currentDatabase(connectionId))}`;
    } else if (dto.level === 'schema') {
      if (!dto.schema) throw new BadRequestException('schema is required for schema-level privileges');
      target = `SCHEMA ${quotePg(dto.schema)}`;
    } else {
      if (!dto.schema || !dto.table) throw new BadRequestException('schema and table are required for table-level privileges');
      target = `TABLE ${quotePg(dto.schema)}.${quotePg(dto.table)}`;
    }

    let sql: string;
    if (kind === 'grant') {
      const withGrant = dto.withGrantOption ? ' WITH GRANT OPTION' : '';
      sql = `GRANT ${privs.join(', ')} ON ${target} TO ${role}${withGrant}`;
    } else {
      sql = `REVOKE ${privs.join(', ')} ON ${target} FROM ${role}`;
    }

    const drv = await this.driver(connectionId);
    try {
      await drv.runRawQuery(sql);
    } finally {
      await drv.close().catch(() => {});
    }
    await this.audit.log({
      userId, connectionId, action: 'SCHEMA_CHANGE',
      sqlText: sql, ...meta,
      metadata: { feature: 'db-users', op: kind, level: dto.level, role: dto.role },
    });
    return { ok: true };
  }

  async addMembership(connectionId: string, dto: MembershipDto, userId: string, meta: AuditMeta) {
    return this.membership('grant', connectionId, dto, userId, meta);
  }
  async removeMembership(connectionId: string, dto: MembershipDto, userId: string, meta: AuditMeta) {
    return this.membership('revoke', connectionId, dto, userId, meta);
  }
  private async membership(kind: 'grant' | 'revoke', connectionId: string, dto: MembershipDto, userId: string, meta: AuditMeta) {
    await this.assertPostgres(connectionId);
    const parent = quotePg(dto.parentRole);
    const member = quotePg(dto.memberRole);
    const sql = kind === 'grant'
      ? `GRANT ${parent} TO ${member}`
      : `REVOKE ${parent} FROM ${member}`;
    const drv = await this.driver(connectionId);
    try {
      await drv.runRawQuery(sql);
    } finally {
      await drv.close().catch(() => {});
    }
    await this.audit.log({
      userId, connectionId, action: 'SCHEMA_CHANGE',
      sqlText: sql, ...meta,
      metadata: { feature: 'db-users', op: `membership-${kind}`, parent: dto.parentRole, member: dto.memberRole },
    });
    return { ok: true };
  }

  private async currentDatabase(connectionId: string): Promise<string> {
    const drv = await this.driver(connectionId);
    try {
      const r = await drv.runRawQuery('SELECT current_database() AS db');
      const db = r.rows[0]?.db;
      if (typeof db !== 'string') throw new BadRequestException('Could not resolve current database');
      return db;
    } finally {
      await drv.close().catch(() => {});
    }
  }
}

type AuditMeta = { ip?: string; userAgent?: string };

/** Single-quote a string literal for SQL, escaping embedded quotes. Used only
 *  where bind params are not accepted by the grammar (PASSWORD, VALID UNTIL). */
function literal(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Replace the PASSWORD literal in a statement before it's written to the audit
 *  log so plaintext passwords are never persisted. */
function redactPassword(sql: string): string {
  return sql.replace(/PASSWORD\s+'(?:[^']|'')*'/i, "PASSWORD '***'");
}

const PRIVS_BY_LEVEL: Record<string, Set<string>> = {
  database: new Set(['ALL', 'CONNECT', 'CREATE', 'TEMPORARY']),
  schema: new Set(['ALL', 'USAGE', 'CREATE']),
  table: new Set(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
};

/** Validate + canonicalize the requested privileges for the given level. */
function normalizePrivileges(level: string, requested: string[]): string[] {
  const allowed = PRIVS_BY_LEVEL[level];
  if (!allowed) throw new BadRequestException(`Invalid privilege level: ${level}`);
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new BadRequestException('At least one privilege is required');
  }
  const out = new Set<string>();
  for (const p of requested) {
    const up = String(p).trim().toUpperCase();
    if (!allowed.has(up)) {
      throw new BadRequestException(`Privilege "${p}" is not valid at the ${level} level`);
    }
    out.add(up === 'ALL' ? 'ALL PRIVILEGES' : up);
  }
  // If ALL is present, it subsumes everything else.
  if (out.has('ALL PRIVILEGES')) return ['ALL PRIVILEGES'];
  return [...out];
}
