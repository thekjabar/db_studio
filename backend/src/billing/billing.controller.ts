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

/**
 * Customer-facing billing + Wayl checkout. All routes require the customer JWT
 * except the webhook, which is @Public() and instead verifies Wayl's HMAC
 * signature over the raw request body.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Public plan catalogue for the marketing pricing section (no auth). */
  @Public()
  @Get('plans/public')
  publicPlans() {
    return this.billing.publicPlans();
  }

  /** Current plan, seats, tier catalogue and recent payments. */
  @Get()
  overview(@CurrentUser() u: AuthUser, @Query('workspaceId') workspaceId?: string) {
    return this.billing.overview(u.id, workspaceId);
  }

  /** Begin checkout for `seats` seats on the paid plan — returns the Wayl URL. */
  @Post('checkout')
  checkout(
    @CurrentUser() u: AuthUser,
    @Body('seats') seats: number,
    @Body('workspaceId') workspaceId?: string,
  ) {
    const n = Math.floor(Number(seats));
    if (!Number.isFinite(n) || n < 1) {
      throw new BadRequestException('Choose at least 1 seat.');
    }
    return this.billing.checkout(u.id, n, workspaceId);
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
