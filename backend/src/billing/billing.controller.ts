import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, type AuthUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { BillingService } from './billing.service';
import type { PlanTier } from '@prisma/client';

const PAID_TIERS: PlanTier[] = ['PRO', 'TEAM'];

/**
 * Customer-facing billing + Wayl checkout. All routes require the customer JWT
 * except the webhook, which is @Public() and instead verifies Wayl's HMAC
 * signature over the raw request body.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Current plan, seats, tier catalogue and recent payments. */
  @Get()
  overview(@CurrentUser() u: AuthUser, @Query('workspaceId') workspaceId?: string) {
    return this.billing.overview(u.id, workspaceId);
  }

  /** Begin checkout for a paid tier — returns the Wayl hosted-checkout URL. */
  @Post('checkout')
  checkout(
    @CurrentUser() u: AuthUser,
    @Body('plan') plan: string,
    @Body('workspaceId') workspaceId?: string,
  ) {
    if (!PAID_TIERS.includes(plan as PlanTier)) {
      throw new BadRequestException('Choose a paid plan (PRO or TEAM).');
    }
    return this.billing.checkout(u.id, plan as PlanTier, workspaceId);
  }

  /** Re-check a payment straight from Wayl after the customer returns. */
  @Post('verify/:referenceId')
  @HttpCode(200)
  verify(@CurrentUser() u: AuthUser, @Param('referenceId') referenceId: string) {
    return this.billing.verifyReturn(u.id, referenceId);
  }

  /** Wayl → us. Public; trust comes from the HMAC over the raw body. */
  @Public()
  @Post('wayl/webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-wayl-signature-256') signature: string | undefined,
    @Body() _body: unknown, // present so Nest still routes the request
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(_body ?? {}));
    return this.billing.handleWebhook(raw, signature);
  }
}
