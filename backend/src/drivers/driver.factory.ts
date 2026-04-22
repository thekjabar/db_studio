import { BadRequestException, Injectable } from '@nestjs/common';
import { Dialect } from '@prisma/client';
import { IDatabaseDriver, ConnectionCredentials, DriverOptions } from './driver.interface';
import { PostgresDriver } from './postgres.driver';
import { MysqlDriver } from './mysql.driver';
import { SqliteDriver } from './sqlite.driver';
import { MssqlDriver } from './mssql.driver';

@Injectable()
export class DriverFactory {
  create(dialect: Dialect, creds: ConnectionCredentials, opts: DriverOptions = {}): IDatabaseDriver {
    switch (dialect) {
      case 'POSTGRES': return new PostgresDriver(creds, opts);
      case 'MYSQL': return new MysqlDriver(creds, opts);
      case 'SQLITE': return new SqliteDriver(creds, opts);
      case 'MSSQL': return new MssqlDriver(creds, opts);
      default: throw new BadRequestException(`Unsupported dialect ${dialect}`);
    }
  }
}
