import {
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

type MaybePgError = {
  code?: string;
  errno?: string | number;
  message?: string;
  address?: string;
  port?: number;
};

/**
 * Translates low-level driver errors (pg, mysql2, tedious, sqlite) into
 * typed HTTP exceptions so the frontend gets a meaningful status + message
 * instead of an opaque 500.
 */
export function toDriverHttpError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;

  const e = (err ?? {}) as MaybePgError;
  const msg = (e.message || '').toLowerCase();
  const code = String(e.code ?? e.errno ?? '');

  if (code === 'ENOTFOUND' || msg.includes('getaddrinfo')) {
    return new ServiceUnavailableException(
      'Database host could not be resolved (DNS failure). Check host/IP.',
    );
  }
  if (code === 'ECONNREFUSED') {
    return new ServiceUnavailableException(
      'Database refused the connection. Check port and that the server is running.',
    );
  }
  if (
    code === 'ETIMEDOUT' ||
    msg.includes('connection terminated due to connection timeout') ||
    msg.includes('timeout expired')
  ) {
    return new GatewayTimeoutException(
      'Timed out reaching the database. The server may be unreachable, or a firewall is blocking the port.',
    );
  }
  if (msg.includes('self signed certificate') || msg.includes('self-signed certificate')) {
    return new ServiceUnavailableException(
      'The server uses a self-signed certificate. Lower sslMode to "require" or install the CA.',
    );
  }
  if (msg.includes('no pg_hba.conf') || msg.includes('ssl off') || msg.includes('ssl is not enabled')) {
    return new ServiceUnavailableException(
      'SSL mode mismatch with server. Try changing sslMode (require / disable).',
    );
  }
  // Postgres auth failures: SQLSTATE 28P01 (password) / 28000 (auth method)
  // MySQL auth: ER_ACCESS_DENIED_ERROR = 1045
  // MSSQL auth: "Login failed for user"
  if (
    code === '28P01' ||
    code === '28000' ||
    code === '1045' ||
    code === 'ER_ACCESS_DENIED_ERROR' ||
    msg.includes('password authentication failed') ||
    msg.includes('access denied') ||
    msg.includes('login failed')
  ) {
    return new UnauthorizedException('Invalid username or password.');
  }
  // Postgres: database does not exist (3D000)
  // MySQL: ER_BAD_DB_ERROR = 1049
  // MSSQL: "Cannot open database ... requested by the login"
  if (
    code === '3D000' ||
    code === '1049' ||
    code === 'ER_BAD_DB_ERROR' ||
    (msg.includes('database') && msg.includes('does not exist')) ||
    msg.includes('cannot open database')
  ) {
    return new BadRequestException('Database does not exist.');
  }

  return new ServiceUnavailableException(
    e.message ? `Database error: ${e.message}` : 'Database is unreachable.',
  );
}
