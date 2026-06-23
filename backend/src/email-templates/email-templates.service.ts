import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULTS: Record<string, { subject: string; bodyHtml: string; bodyText: string; variables: string[] }> = {
  welcome: {
    subject: 'Welcome to {{appName}}',
    bodyText: 'Hi {{recipientName}},\n\nWelcome to {{appName}}. Let us know if you need anything.',
    bodyHtml: '<p>Hi {{recipientName}},</p><p>Welcome to {{appName}}. Let us know if you need anything.</p>',
    variables: ['appName', 'recipientName'],
  },
  password_reset: {
    subject: 'Reset your {{appName}} password',
    bodyText: 'Click this link to reset your password: {{resetUrl}}\n\nThis link expires in 1 hour.',
    bodyHtml: '<p>Click <a href="{{resetUrl}}">here</a> to reset your password.</p><p>This link expires in 1 hour.</p>',
    variables: ['appName', 'resetUrl'],
  },
  email_verification: {
    subject: 'Verify your email for {{appName}}',
    bodyText: 'Please verify your email: {{verifyUrl}}',
    bodyHtml: '<p>Please <a href="{{verifyUrl}}">verify your email</a>.</p>',
    variables: ['appName', 'verifyUrl'],
  },
  subscription_past_due: {
    subject: 'Your {{appName}} subscription is past due',
    bodyText: 'Your workspace {{workspaceName}} has a past-due subscription. Please update billing soon.',
    bodyHtml: '<p>Your workspace <strong>{{workspaceName}}</strong> has a past-due subscription. Please update billing soon.</p>',
    variables: ['appName', 'workspaceName'],
  },
  invoice: {
    subject: 'Invoice for {{workspaceName}}',
    bodyText: 'Seats: {{seats}}\nAI packs: {{packs}}\nTotal: {{totalFormatted}}',
    bodyHtml: '<p>Seats: {{seats}}<br/>AI packs: {{packs}}<br/>Total: {{totalFormatted}}</p>',
    variables: ['workspaceName', 'seats', 'packs', 'totalFormatted'],
  },
  feedback_reply: {
    subject: 'Re: your feedback',
    bodyText: '{{body}}',
    bodyHtml: '<div>{{body}}</div>',
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
