import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { AppConfigService } from '../config/config.service';

/**
 * Outbound email. Prefers Resend's native HTTP API (better deliverability,
 * no SMTP port blocking, bounce webhooks) and falls back to generic SMTP
 * when only SMTP is configured. CSV results are attached as base64.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly log = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private transporter: Transporter | null = null;

  constructor(private readonly cfg: AppConfigService) {}

  onModuleInit() {
    if (this.cfg.resendEnabled) {
      this.resend = new Resend(this.cfg.resendApiKey!);
      this.log.log('Email enabled via Resend API');
      return;
    }
    if (this.cfg.smtpUrl && this.cfg.smtpFrom) {
      this.transporter = createTransport(this.cfg.smtpUrl);
      this.log.log('Email enabled via SMTP');
      return;
    }
    this.log.log('Email disabled (set RESEND_API_KEY + RESEND_FROM, or SMTP_URL + SMTP_FROM)');
  }

  get enabled() {
    return !!this.resend || !!this.transporter;
  }

  async send(params: {
    to: string[];
    subject: string;
    body: string;
    html?: string;
    csv?: string;
    filename?: string;
  }): Promise<void> {
    const from = this.cfg.mailFrom;
    if (!from) throw new Error('Email not configured (no from address)');

    // Resend path (preferred).
    if (this.resend) {
      const { error } = await this.resend.emails.send({
        from,
        to: params.to,
        subject: params.subject,
        text: params.body,
        ...(params.html ? { html: params.html } : {}),
        attachments: params.csv
          ? [
              {
                filename: params.filename ?? 'result.csv',
                content: Buffer.from(params.csv, 'utf8').toString('base64'),
              },
            ]
          : undefined,
      } as Parameters<Resend['emails']['send']>[0]);
      // Resend returns { error } instead of throwing on API errors.
      if (error) {
        throw new Error(`Resend send failed: ${error.message ?? String(error)}`);
      }
      return;
    }

    // SMTP fallback.
    if (this.transporter) {
      await this.transporter.sendMail({
        from,
        to: params.to.join(', '),
        subject: params.subject,
        text: params.body,
        ...(params.html ? { html: params.html } : {}),
        attachments: params.csv
          ? [{ filename: params.filename ?? 'result.csv', content: params.csv }]
          : undefined,
      });
      return;
    }

    throw new Error('Email not configured');
  }
}
