import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { ConnectionsService } from './connections.service';

export interface SensitiveFinding {
  schema: string;
  table: string;
  column: string;
  dataType: string;
  /** What kind of sensitive data this looks like. */
  kind: string;
  /** Why it was flagged — for the operator/owner to evaluate. */
  reason: string;
  /** Rough confidence: name match alone = medium, name + type = high. */
  confidence: 'high' | 'medium';
}

// Name-based PII heuristics. Conservative: better to flag a bit too much
// than miss obvious password/token/ssn columns. Each pattern maps to a kind.
const NAME_RULES: { kind: string; re: RegExp }[] = [
  { kind: 'password', re: /passw(or)?d|passhash|pwd/i },
  { kind: 'secret/token', re: /secret|token|api.?key|private.?key|credential/i },
  { kind: 'email', re: /e?mail/i },
  { kind: 'phone', re: /phone|mobile|msisdn|tel(ephone)?/i },
  { kind: 'national id', re: /ssn|social.?sec|national.?id|passport|tax.?id|iban/i },
  { kind: 'payment card', re: /card.?(number|no|num)|cc.?num|pan\b|cvv|cvc/i },
  { kind: 'address', re: /address|street|postcode|zip.?code/i },
  { kind: 'date of birth', re: /birth|dob\b/i },
  { kind: 'ip address', re: /\bip(_|$)|ip.?addr/i },
  { kind: 'salary/financial', re: /salary|income|balance|account.?(no|number)/i },
];

/**
 * Scans a connection's schema for likely-sensitive columns by name + type
 * heuristics. Pairs with column masks: findings link straight to "mask this
 * column". Read-only — introspection only, never reads row data.
 */
@Controller('connections/:id/sensitive-scan')
@UseGuards(RbacGuard)
export class SensitiveScanController {
  constructor(private readonly connections: ConnectionsService) {}

  @Post()
  @HttpCode(200)
  @RequireRole('OWNER')
  async scan(@Param('id') id: string): Promise<{ findings: SensitiveFinding[]; tablesScanned: number }> {
    const drv = await this.connections.buildDriverForRole(id, Role.VIEWER);
    try {
      const er = await drv.introspectForER();
      const findings: SensitiveFinding[] = [];
      for (const t of er.tables) {
        for (const c of t.columns) {
          for (const rule of NAME_RULES) {
            if (rule.re.test(c.name)) {
              const texty = /char|text|citext|json/i.test(c.dataType);
              findings.push({
                schema: t.schema,
                table: t.name,
                column: c.name,
                dataType: c.dataType,
                kind: rule.kind,
                reason: `Column name matches "${rule.kind}" pattern`,
                confidence: texty ? 'high' : 'medium',
              });
              break; // one kind per column is enough
            }
          }
        }
      }
      return { findings, tablesScanned: er.tables.length };
    } finally {
      await drv.close().catch(() => {});
    }
  }
}
