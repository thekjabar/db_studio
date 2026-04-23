import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';
import { RbacModule } from '../rbac/rbac.module';
import { FederatedController } from './federated.controller';
import { FederatedService } from './federated.service';

@Module({
  imports: [PrismaModule, CryptoModule, RbacModule],
  controllers: [FederatedController],
  providers: [FederatedService],
})
export class FederatedModule {}
