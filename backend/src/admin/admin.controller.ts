import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { Public } from '../auth/decorators/public.decorator';
import { AppConfigService } from '../config/config.service';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';

class SetAdminDto {
  @IsBoolean() isAdmin!: boolean;
}

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  @Get('overview')
  overview() {
    return this.svc.overview();
  }

  @Get('query-volume')
  queryVolume() {
    return this.svc.queryVolume24h();
  }

  @Get('top-connections')
  topConnections(@Query('limit') limit?: string) {
    return this.svc.topConnections7d(limit ? parseInt(limit, 10) : 10);
  }

  @Get('top-users')
  topUsers(@Query('limit') limit?: string) {
    return this.svc.topUsers7d(limit ? parseInt(limit, 10) : 10);
  }

  @Get('users')
  listUsers(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.svc.listUsers({
      search: search || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      cursor: cursor || undefined,
    });
  }

  @Patch('users/:id')
  async setAdmin(@Param('id') id: string, @Body() dto: SetAdminDto, @Req() req: Request) {
    const me = (req as any).user as { id: string };
    // Don't allow the last remaining admin to demote themselves. The overview
    // surface already prevents this in the UI but the server must too — an
    // empty admin set bricks the /admin surface.
    if (me.id === id && dto.isAdmin === false) {
      throw new ForbiddenException("You can't demote yourself while you're the only admin");
    }
    return this.svc.setAdmin(id, dto.isAdmin);
  }
}

/**
 * Prometheus metrics scrape endpoint. Not under JWT — Prometheus servers
 * can't hold a JWT. Protected instead by `METRICS_TOKEN` via bearer header.
 * Without a token set the endpoint is disabled (returns 404-equivalent).
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly admin: AdminService,
    private readonly metrics: MetricsService,
    private readonly cfg: AppConfigService,
  ) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(@Req() req: Request, @Res({ passthrough: false }) res: Response) {
    const token = this.cfg.metricsToken;
    if (!token) {
      res.status(404).end();
      return;
    }
    const header = req.headers.authorization;
    if (!header || header !== `Bearer ${token}`) {
      res.status(401).end();
      return;
    }
    await this.admin.refreshGauges();
    res.status(200).send(this.metrics.render());
  }
}
