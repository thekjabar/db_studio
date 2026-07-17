import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OperatorAuthController } from './operator-auth.controller';
import { OperatorAuthService } from './operator-auth.service';
import { LoginCooldownService } from '../auth/login-cooldown.service';
import { OperatorGuard, SuperOperatorGuard } from './operator.guard';
import { OperatorAuditService } from './operator-audit.service';
import { AiQuotaService } from './ai-quota.service';
import { OperatorUsersController } from './operator-users.controller';
import { OperatorWorkspacesController } from './operator-workspaces.controller';
import { OperatorBillingController } from './operator-billing.controller';
import { OperatorDashboardController } from './operator-dashboard.controller';
import { OperatorAuditController } from './operator-audit.controller';
import { OperatorOperatorsController } from './operator-operators.controller';

@Module({
  imports: [JwtModule.register({})],
  controllers: [
    OperatorAuthController,
    OperatorUsersController,
    OperatorWorkspacesController,
    OperatorBillingController,
    OperatorDashboardController,
    OperatorAuditController,
    OperatorOperatorsController,
  ],
  providers: [OperatorAuthService, OperatorAuditService, AiQuotaService, OperatorGuard, SuperOperatorGuard, LoginCooldownService],
  // Re-export JwtModule so modules importing OperatorModule (to use
  // OperatorGuard) don't also need to register their own JWT provider.
  exports: [OperatorAuditService, OperatorGuard, AiQuotaService, JwtModule],
})
export class OperatorModule {}
