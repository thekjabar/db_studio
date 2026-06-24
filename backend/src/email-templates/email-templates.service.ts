import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

import { renderEmail } from '../scheduler/email-layout';

const DEFAULTS: Record<string, { subject: string; bodyHtml: string; bodyText: string; variables: string[] }> = {
  welcome: {
    subject: 'Welcome to {{appName}}',
    bodyText: 'Hi {{recipientName}},\n\nWelcome to {{appName}}. Let us know if you need anything.',
    bodyHtml: renderEmail({
      title: 'Welcome to {{appName}} 👋',
      intro: 'Hi {{recipientName}},\nThanks for joining {{appName}} — your studio for browsing, querying, and sharing across every database. If you need anything at all, just reply to this email.',
    }),
    variables: ['appName', 'recipientName'],
  },
  password_reset: {
    subject: 'Reset your {{appName}} password',
    bodyText: 'Click this link to reset your password: {{resetUrl}}\n\nThis link expires in 1 hour.',
    bodyHtml: renderEmail({
      title: 'Reset your password',
      intro: 'We got a request to reset your {{appName}} password. Click the button below to choose a new one.',
      button: { label: 'Reset password', url: '{{resetUrl}}' },
      note: "This link expires in 1 hour. If you didn't request it, you can ignore this email.",
    }),
    variables: ['appName', 'resetUrl'],
  },
  email_verification: {
    subject: 'Verify your email for {{appName}}',
    bodyText: 'Please verify your email: {{verifyUrl}}',
    bodyHtml: renderEmail({
      title: 'Verify your email',
      intro: 'Confirm your email address to finish setting up your {{appName}} account.',
      button: { label: 'Verify email', url: '{{verifyUrl}}' },
      note: 'This link expires in 24 hours.',
    }),
    variables: ['appName', 'verifyUrl'],
  },
  subscription_past_due: {
    subject: 'Your {{appName}} subscription is past due',
    bodyText: 'Your workspace {{workspaceName}} has a past-due subscription. Please update billing soon.',
    bodyHtml: renderEmail({
      title: 'Your subscription is past due',
      intro: 'The subscription for workspace "{{workspaceName}}" is past due. Please update your billing details to avoid any interruption.',
    }),
    variables: ['appName', 'workspaceName'],
  },
  invoice: {
    subject: 'Invoice for {{workspaceName}}',
    bodyText: 'Seats: {{seats}}\nAI packs: {{packs}}\nTotal: {{totalFormatted}}',
    bodyHtml: renderEmail({
      title: 'Invoice for {{workspaceName}}',
      intro: 'Here is your latest invoice summary.',
      html: '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-top:1px solid #262b29;">'
        + '<tr><td style="padding:10px 0;color:#8a938f;font-size:14px;">Seats</td><td style="padding:10px 0;text-align:right;color:#e6eae8;font-size:14px;">{{seats}}</td></tr>'
        + '<tr><td style="padding:10px 0;color:#8a938f;font-size:14px;border-top:1px solid #262b29;">AI packs</td><td style="padding:10px 0;text-align:right;color:#e6eae8;font-size:14px;border-top:1px solid #262b29;">{{packs}}</td></tr>'
        + '<tr><td style="padding:10px 0;color:#e6eae8;font-size:15px;font-weight:600;border-top:1px solid #262b29;">Total</td><td style="padding:10px 0;text-align:right;color:#3ECF8E;font-size:15px;font-weight:600;border-top:1px solid #262b29;">{{totalFormatted}}</td></tr>'
        + '</table>',
    }),
    variables: ['workspaceName', 'seats', 'packs', 'totalFormatted'],
  },
  feedback_reply: {
    subject: 'Re: your feedback',
    bodyText: '{{body}}',
    bodyHtml: renderEmail({
      title: 'Reply to your feedback',
      intro: '{{body}}',
    }),
    variables: ['body'],
  },
};

/**
 * Email template storage. The app's transactional senders go through
 * `render(name, vars)` so operators can tweak copy without a deploy.
 * When a row is missing from the DB we fall back to the hardcoded
 * default — this means a wiped table never breaks login emails.
 */
@Injectable()
export class EmailTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.emailTemplate.findMany({ orderBy: { name: 'asc' } });
    const known = new Set(rows.map((r) => r.name));
    // Seed defaults lazily so the admin UI always shows all templates.
    for (const [name, t] of Object.entries(DEFAULTS)) {
      if (!known.has(name)) {
        await this.prisma.emailTemplate.create({
          data: {
            name,
            subject: t.subject,
            bodyHtml: t.bodyHtml,
            bodyText: t.bodyText,
            variables: t.variables,
          },
        });
      }
    }
    return this.prisma.emailTemplate.findMany({ orderBy: { name: 'asc' } });
  }

  async update(operatorId: string, name: string, patch: { subject?: string; bodyHtml?: string; bodyText?: string }) {
    return this.prisma.emailTemplate.update({
      where: { name },
      data: { ...patch, updatedByOperatorId: operatorId },
    });
  }

  /** `render('welcome', { appName: 'Query Schema', ... })` */
  async render(name: string, vars: Record<string, string | number>) {
    const row = await this.prisma.emailTemplate.findUnique({ where: { name } });
    const t = row ?? (DEFAULTS[name]
      ? { subject: DEFAULTS[name].subject, bodyHtml: DEFAULTS[name].bodyHtml, bodyText: DEFAULTS[name].bodyText }
      : null);
    if (!t) throw new Error(`Unknown email template: ${name}`);
    return {
      subject: substitute(t.subject, vars),
      bodyHtml: substitute(t.bodyHtml, vars),
      bodyText: substitute(t.bodyText, vars),
    };
  }
}

function substitute(input: string, vars: Record<string, string | number>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v !== undefined ? String(v) : `{{${k}}}`;
  });
}
