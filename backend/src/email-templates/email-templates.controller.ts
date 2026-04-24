import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { OperatorGuard, OperatorRequest } from '../operator/operator.guard';
import { EmailTemplatesService } from './email-templates.service';

class UpdateTemplateDto {
  @IsOptional() @IsString() @Length(1, 500) subject?: string;
  @IsOptional() @IsString() @Length(1, 100_000) bodyHtml?: string;
  @IsOptional() @IsString() @Length(1, 100_000) bodyText?: string;
}

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/email-templates')
export class OperatorEmailTemplatesController {
  constructor(private readonly svc: EmailTemplatesService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Patch(':name')
  update(@Param('name') name: string, @Body() dto: UpdateTemplateDto, @Req() req: OperatorRequest) {
    return this.svc.update(req.operator!.id, name, {
      ...(dto.subject !== undefined ? { subject: dto.subject } : {}),
      ...(dto.bodyHtml !== undefined ? { bodyHtml: dto.bodyHtml } : {}),
      ...(dto.bodyText !== undefined ? { bodyText: dto.bodyText } : {}),
    });
  }
}
