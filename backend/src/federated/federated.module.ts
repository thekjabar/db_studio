import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { RbacModule } from '../rbac/rbac.module';
import { ConnectionsModule } from '../connections/connections.module';
import { FederatedController } from './federated.controller';
import { FederatedService } from './federated.service';

@Module({
  // ConnectionsModule provides ColumnMasksService — federated results are
  // masked for the requesting user (see FederatedService.runQuery).
  imports: [PrismaModule, CryptoModule, RbacModule, ConnectionsModule],
  controllers: [FederatedController],
  providers: [FederatedService],
})
export class FederatedModule {}
