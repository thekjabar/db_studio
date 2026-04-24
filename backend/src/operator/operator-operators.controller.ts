import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorGuard, OperatorRequest, SuperOperatorGuard } from './operator.guard';
import { OperatorAuditService } from './operator-audit.service';
import { Public } from '../auth/decorators/public.decorator';

const CreateDto = z.object({
  email: z.string().email(),
  password: z.string().min(12, 'Operator passwords must be at least 12 characters'),
  displayName: z.string().max(100).optional(),
  isSuper: z.boolean().default(false),
});

/**
 * Manage the operators themselves. List is readable by any operator so
 * they can see who's in the team; mutations require super.
 */
@Public()
@UseGuards(OperatorGuard)
@Controller('operator/operators')
export class OperatorOperatorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OperatorAuditService,
  ) {}

  @Get()
  async list() {
    const rows = await this.prisma.operator.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        isSuper: true,
        disabledAt: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    return rows;
  }

  @Post()
  @UseGuards(SuperOperatorGuard)
  async create(@Body() body: unknown, @Req() req: OperatorRequest) {
    const dto = CreateDto.parse(body);
    const existing = await this.prisma.operator.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Operator email already exists');
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const op = await this.prisma.operator.create({
      data: { email: dto.email, passwordHash, displayName: dto.displayName, isSuper: dto.isSuper },
      select: { id: true, email: true, isSuper: true },
    });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'OPERATOR_CREATED',
      targetType: 'Operator',
      targetId: op.id,
      metadata: { email: op.email, isSuper: op.isSuper },
    });
    return op;
  }

  @Post(':id/disable')
  @UseGuards(SuperOperatorGuard)
  async disable(@Param('id') id: string, @Req() req: OperatorRequest) {
    if (id === req.operator!.id) {
      throw new BadRequestException('Cannot disable yourself');
    }
    const op = await this.prisma.operator.findUnique({ where: { id } });
    if (!op) throw new NotFoundException();
    await this.prisma.operator.update({ where: { id }, data: { disabledAt: new Date() } });
    // Revoke all their sessions.
    await this.prisma.operatorRefreshToken.updateMany({
      where: { operatorId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'OPERATOR_DISABLED',
      targetType: 'Operator',
      targetId: id,
      metadata: { email: op.email },
    });
    return { ok: true as const };
  }

  @Post(':id/enable')
  @UseGuards(SuperOperatorGuard)
  async enable(@Param('id') id: string, @Req() req: OperatorRequest) {
    const op = await this.prisma.operator.findUnique({ where: { id } });
    if (!op) throw new NotFoundException();
    await this.prisma.operator.update({ where: { id }, data: { disabledAt: null } });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'OPERATOR_ENABLED',
      targetType: 'Operator',
      targetId: id,
      metadata: { email: op.email },
    });
    return { ok: true as const };
  }
}
