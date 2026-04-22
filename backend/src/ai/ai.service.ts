import Anthropic from '@anthropic-ai/sdk';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Role, Dialect } from '@prisma/client';
import { AppConfigService } from '../config/config.service';
import { ConnectionsService } from '../connections/connections.service';

interface GenerateArgs {
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
  private client: Anthropic | null = null;

  constructor(
    private readonly cfg: AppConfigService,
    private readonly connections: ConnectionsService,
  ) {
    if (cfg.aiEnabled) {
      this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    }
  }

  async generateSql({ connectionId, prompt, schema }: GenerateArgs): Promise<GeneratedSql> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'AI is disabled on this server — set ANTHROPIC_API_KEY to enable.',
      );
    }
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
      schemaCtx = this.renderSchemaContext(er);
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

    const resp = await this.client.messages.create({
      model: this.cfg.anthropicModel,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const textBlock = resp.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new ServiceUnavailableException('AI returned no text response');
    }
    const raw = textBlock.text.trim();
    const parsed = this.parseResponse(raw);
    if (!parsed.sql) throw new ServiceUnavailableException('AI returned no SQL');
    return parsed;
  }

  private renderSchemaContext(er: { tables: { schema: string; name: string; columns: { name: string; dataType: string; isPrimaryKey: boolean; nullable: boolean }[] }[]; foreignKeys: { schema: string; table: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] }[] }): string {
    const lines: string[] = [];
    // Cap context: huge schemas would blow past model context length.
    const MAX_TABLES = 60;
    const MAX_COLS_PER_TABLE = 40;
    const slice = er.tables.slice(0, MAX_TABLES);
    for (const t of slice) {
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
    if (er.tables.length > MAX_TABLES) {
      lines.push(`-- ${er.tables.length - MAX_TABLES} more tables omitted for context length.`);
    }
    if (er.foreignKeys.length) {
      lines.push('');
      lines.push('FOREIGN KEYS:');
      for (const fk of er.foreignKeys.slice(0, 100)) {
        lines.push(`  ${fk.schema}.${fk.table}(${fk.columns.join(',')}) -> ${fk.refSchema}.${fk.refTable}(${fk.refColumns.join(',')})`);
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
