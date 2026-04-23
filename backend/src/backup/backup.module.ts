import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { DriversModule } from '../drivers/drivers.module';
import { RbacModule } from '../rbac/rbac.module';
import { ConnectionsModule } from '../connections/connections.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

@Module({
  imports: [PrismaModule, CryptoModule, DriversModule, RbacModule, ConnectionsModule],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
