import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { AppConfigService } from '../config/config.service';

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly log = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly cfg: AppConfigService) {}

  onModuleInit() {
    if (!this.cfg.emailEnabled) {
      this.log.log('Email disabled (SMTP_URL or SMTP_FROM not set)');
      return;
    }
    this.transporter = createTransport(this.cfg.smtpUrl!);
  }

  get enabled() {
    return !!this.transporter;
  }

  async send(params: {
    to: string[];
    subject: string;
    body: string;
    csv?: string;
    filename?: string;
  }): Promise<void> {
    if (!this.transporter) {
      throw new Error('Email not configured');
    }
    await this.transporter.sendMail({
      from: this.cfg.smtpFrom!,
      to: params.to.join(', '),
      subject: params.subject,
      text: params.body,
      attachments: params.csv
        ? [{ filename: params.filename ?? 'result.csv', content: params.csv }]
        : undefined,
    });
  }
}
