import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Role, Dialect } from '@prisma/client';
import { AppConfigService } from '../config/config.service';
import { ConnectionsService } from '../connections/connections.service';
import { AiProviderFactory } from './providers/ai-provider.factory';
import { pickRelevantTables } from './ai-chat.service';
import { AiQuotaService } from '../operator/ai-quota.service';

interface GenerateArgs {
  userId: string;
  connectionId: string;
  prompt: string;
  /** Optional schema filter — e.g. "public". When absent, send every schema. */
  schema?: string;
}

export interface GeneratedSql {
  sql: string;
  explanation: string;
  /** Tables the model referenced, if it self-reported. */
  tables: string[];
}

@Injectable()
export class AiService {
  constructor(
    private readonly cfg: AppConfigService,
    private readonly connections: ConnectionsService,
    private readonly providers: AiProviderFactory,
    private readonly quota: AiQuotaService,
  ) {}

  async generateSql({ userId, connectionId, prompt, schema }: GenerateArgs): Promise<GeneratedSql> {
    const provider = this.providers.primary;
    if (!provider || !provider.enabled) {
      throw new ServiceUnavailableException(
        'AI is disabled on this server — configure at least one provider (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, …).',
      );
    }
    // Billing gate: this throws 402 if the user is over their daily cap,
    // suspended, or belongs to no active workspace. Call BEFORE any
    // expensive work so we don't pay a provider for a request we'll
    // refuse to deliver.
    await this.quota.consume(userId);

    const clean = prompt.trim();
    if (!clean) throw new BadRequestException('Prompt is required');
    if (clean.length > 4_000) throw new BadRequestException('Prompt too long');

    // Load schema context. We use VIEWER-role drivers for safety — assistant
    // never triggers a side-effecting query during introspection.
    const drv = await this.connections.buildDriverForRole(connectionId, Role.VIEWER);
    let schemaCtx: string;
    let dialect: Dialect;
    try {
      const connRow = await this.connections.get(connectionId);
      dialect = connRow.dialect;
      const er = await drv.introspectForER(schema);
      schemaCtx = this.renderSchemaContext(er, clean);
    } finally {
      await drv.close().catch(() => {});
    }

    const system = `You are a careful SQL assistant for a ${dialect} database.
Rules:
- Generate ONE single SQL statement that satisfies the user's request.
- Use ONLY the tables and columns listed below. Never invent identifiers.
- Prefer SELECT over DDL/DML unless the user explicitly asks for a change.
- For row-limiting SELECTs, include a LIMIT of 100 unless the user asked for more.
- Use dialect-appropriate syntax (e.g. Postgres \`ILIKE\`, MySQL backticks, etc.).
- Quote identifiers only if they contain uppercase/spaces/reserved words.
- When uncertain, pick the simplest correct query and note assumptions in the explanation.

Return ONLY a JSON object of shape:
{ "sql": "<the SQL>", "explanation": "<1-2 sentences about what it does>", "tables": ["<table names referenced>"] }
No markdown fences, no prose before/after.`;

    const user = `Schema:
${schemaCtx}

User request:
${clean}`;

    const resp = await provider.generate({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1024,
    });
    const raw = resp.text.trim();
    const parsed = this.parseResponse(raw);
    if (!parsed.sql) throw new ServiceUnavailableException('AI returned no SQL');
    return parsed;
  }

  private renderSchemaContext(
    er: {
      tables: {
        schema: string;
        name: string;
        columns: { name: string; dataType: string; isPrimaryKey: boolean; nullable: boolean }[];
      }[];
      foreignKeys: {
        schema: string;
        table: string;
        columns: string[];
        refSchema: string;
        refTable: string;
        refColumns: string[];
      }[];
    },
    hintText: string,
  ): string {
    const MAX_TABLES = 60;
    const MAX_COLS_PER_TABLE = 60;
    const tables = pickRelevantTables(er, hintText, MAX_TABLES);
    const included = new Set(tables.map((t) => `${t.schema}.${t.name}`));

    const lines: string[] = [];
    for (const t of tables) {
      const cols = t.columns.slice(0, MAX_COLS_PER_TABLE).map((c) => {
        const pk = c.isPrimaryKey ? ' PK' : '';
        const nn = c.nullable ? '' : ' NOT NULL';
        return `  ${c.name} ${c.dataType}${pk}${nn}`;
      });
      if (t.columns.length > MAX_COLS_PER_TABLE) {
        cols.push(`  ... (${t.columns.length - MAX_COLS_PER_TABLE} more columns omitted)`);
      }
      lines.push(`TABLE ${t.schema}.${t.name}:\n${cols.join('\n')}`);
    }
    const omitted = er.tables.length - tables.length;
    if (omitted > 0) {
      lines.push(`-- ${omitted} other table(s) in this database were omitted to stay under token limits.`);
    }
    const relevantFks = er.foreignKeys.filter(
      (fk) =>
        included.has(`${fk.schema}.${fk.table}`) &&
        included.has(`${fk.refSchema}.${fk.refTable}`),
    );
    if (relevantFks.length) {
      lines.push('');
      lines.push('FOREIGN KEYS:');
      for (const fk of relevantFks.slice(0, 300)) {
        const cols = Array.isArray(fk.columns) ? fk.columns.join(',') : String(fk.columns ?? '');
        const refCols = Array.isArray(fk.refColumns) ? fk.refColumns.join(',') : String(fk.refColumns ?? '');
        lines.push(`  ${fk.schema}.${fk.table}(${cols}) -> ${fk.refSchema}.${fk.refTable}(${refCols})`);
      }
    }
    return lines.join('\n');
  }

  private parseResponse(raw: string): GeneratedSql {
    // Strip code fences if the model ignored the instruction.
    let txt = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    // If it returned prose + a JSON block, pick the JSON block.
    const match = txt.match(/\{[\s\S]*\}/);
    if (match) txt = match[0];
    try {
      const parsed = JSON.parse(txt) as GeneratedSql;
      return {
        sql: String(parsed.sql ?? '').trim(),
        explanation: String(parsed.explanation ?? ''),
        tables: Array.isArray(parsed.tables) ? parsed.tables.map(String) : [],
      };
    } catch {
      // Last resort: return the whole thing as SQL, no explanation.
      return { sql: raw.trim(), explanation: '', tables: [] };
    }
  }
}
