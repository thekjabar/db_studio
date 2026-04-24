import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { ConnectionsService } from '../connections/connections.service';
import { RbacService } from '../rbac/rbac.service';
import { AiProviderFactory } from './providers/ai-provider.factory';
import { AiQuotaService } from '../operator/ai-quota.service';

/**
 * Persistent AI chat: conversation scoped to a connection. Each turn we
 * send the full message history + the connection's schema context to the
 * configured provider (Anthropic, Gemini, OpenAI, Groq, OpenRouter, or a
 * local Ollama), extract any SQL the model proposes, and store both turns.
 *
 * We keep SQL extraction simple: the model is asked to return
 * `` ```sql ... ``` `` fenced blocks. The last SQL block in the assistant
 * message is promoted to `sqlBlock` so the UI can render a "Run" button.
 */
@Injectable()
export class AiChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly connections: ConnectionsService,
    private readonly rbac: RbacService,
    private readonly providers: AiProviderFactory,
    private readonly quota: AiQuotaService,
  ) {}

  async list(userId: string, connectionId: string) {
    await this.rbac.require(userId, connectionId, Role.VIEWER);
    return this.prisma.aiChat.findMany({
      where: { connectionId, userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, updatedAt: true, createdAt: true },
    });
  }

  async get(userId: string, id: string) {
    const chat = await this.prisma.aiChat.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!chat) throw new NotFoundException('Chat not found');
    if (chat.userId !== userId) throw new ForbiddenException();
    return chat;
  }

  async remove(userId: string, id: string) {
    const chat = await this.prisma.aiChat.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!chat) throw new NotFoundException();
    if (chat.userId !== userId) throw new ForbiddenException();
    await this.prisma.aiChat.delete({ where: { id } });
    return { ok: true as const };
  }

  /** Append a user message, call the model, persist assistant response, return
   *  the created assistant message. Auto-creates a chat on first call. */
  async sendMessage(
    userId: string,
    input: { chatId?: string; connectionId: string; content: string },
  ) {
    const provider = this.providers.primary;
    if (!provider) {
      throw new ServiceUnavailableException(
        'AI is disabled on this server — set an API key for one of: Anthropic, Gemini, OpenAI, Groq, OpenRouter, or Ollama.',
      );
    }
    const content = input.content.trim();
    if (!content) throw new BadRequestException('Message required');
    if (content.length > 4000) throw new BadRequestException('Message too long');
    await this.rbac.require(userId, input.connectionId, Role.VIEWER);
    // Billing gate: 402 if user has hit their daily allowance. Runs after
    // validation so malformed requests don't consume a call, but before we
    // persist anything or call the model.
    await this.quota.consume(userId);

    // Get or create the chat. First message becomes the title.
    let chatId = input.chatId;
    if (!chatId) {
      const chat = await this.prisma.aiChat.create({
        data: {
          connectionId: input.connectionId,
          userId,
          title: content.slice(0, 80),
        },
      });
      chatId = chat.id;
    } else {
      const chat = await this.prisma.aiChat.findUnique({
        where: { id: chatId },
        select: { userId: true, connectionId: true },
      });
      if (!chat) throw new NotFoundException();
      if (chat.userId !== userId) throw new ForbiddenException();
      if (chat.connectionId !== input.connectionId) {
        throw new BadRequestException('Connection mismatch');
      }
    }

    // Persist user message.
    await this.prisma.aiMessage.create({
      data: { chatId, role: 'user', content },
    });

    // Assemble history — cap at last 30 turns to stay under context limits.
    const history = await this.prisma.aiMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
      take: 60,
    });
    const messages: { role: 'user' | 'assistant'; content: string }[] = history.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    // Load schema context — one-time per call, not persisted. We pass the
    // conversation text so the renderer can pick only schema-relevant tables
    // (keeps token usage under provider rate limits on big schemas).
    const drv = await this.connections.buildDriverForRole(input.connectionId, Role.VIEWER);
    let dialect: Dialect;
    let schemaCtx: string;
    try {
      const conn = await this.connections.get(input.connectionId);
      dialect = conn.dialect;
      const er = await drv.introspectForER();
      const hintText = messages.map((m) => m.content).join(' ');
      schemaCtx = this.renderSchemaContext(er, hintText);
    } finally {
      await drv.close().catch(() => {});
    }

    const system = `You are a careful SQL assistant for a ${dialect} database.

Rules — follow these strictly:
- Use ONLY the exact table and column names listed under "Schema" below. Do NOT invent, pluralize, singularize, or guess identifiers. If a table the user asks about is not in the schema, say so explicitly and list the closest matches by name from the schema — do not fabricate a query.
- When appropriate, include exactly one executable SQL statement in a \`\`\`sql fenced block.
- Prefer SELECT. Only propose DDL/DML when the user explicitly asks for one.
- For row-limiting SELECTs, include a LIMIT of 100 unless the user asked otherwise.
- Use the FOREIGN KEYS section to choose JOIN conditions — prefer FK-backed joins over guessing column names.
- You may answer follow-up questions without generating SQL when the user is asking for explanation or clarification.

Schema:
${schemaCtx}`;

    const resp = await provider.generate({
      system,
      messages,
      maxTokens: 2048,
    });
    const assistantText = resp.text || '(no response)';
    const sqlBlock = extractLastSqlBlock(assistantText);

    const saved = await this.prisma.aiMessage.create({
      data: {
        chatId,
        role: 'assistant',
        content: assistantText,
        sqlBlock: sqlBlock ?? null,
      },
    });
    // Bump the chat's updatedAt so the list sorts correctly.
    await this.prisma.aiChat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
    return { chatId, message: saved };
  }

  /**
   * Render a schema context for the model. On big schemas we rank tables by
   * relevance to the conversation text (names mentioned, FK neighbors) and
   * only include the top N — this keeps us under provider TPM/rate limits.
   * If no relevant tables are found we fall back to a first-N slice.
   */
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
    const includedNames = new Set(tables.map((t) => `${t.schema}.${t.name}`));

    const lines: string[] = [];
    for (const t of tables) {
      const cols = t.columns.slice(0, MAX_COLS_PER_TABLE).map((c) => {
        const pk = c.isPrimaryKey ? ' PK' : '';
        const nn = c.nullable ? '' : ' NOT NULL';
        return `  ${c.name} ${c.dataType}${pk}${nn}`;
      });
      if (t.columns.length > MAX_COLS_PER_TABLE) {
        cols.push(`  ... (${t.columns.length - MAX_COLS_PER_TABLE} more)`);
      }
      lines.push(`TABLE ${t.schema}.${t.name}:\n${cols.join('\n')}`);
    }
    const omitted = er.tables.length - tables.length;
    if (omitted > 0) {
      lines.push(
        `-- ${omitted} other table(s) exist in this database but were omitted to stay under token limits. Ask about them by name to include them.`,
      );
    }
    // Only FKs where both endpoints are in the included set — dangling
    // references would just confuse the model.
    const relevantFks = er.foreignKeys.filter(
      (fk) =>
        includedNames.has(`${fk.schema}.${fk.table}`) &&
        includedNames.has(`${fk.refSchema}.${fk.refTable}`),
    );
    if (relevantFks.length) {
      lines.push('');
      lines.push('FOREIGN KEYS:');
      for (const fk of relevantFks.slice(0, 300)) {
        const cols = Array.isArray(fk.columns) ? fk.columns.join(',') : String(fk.columns ?? '');
        const refCols = Array.isArray(fk.refColumns) ? fk.refColumns.join(',') : String(fk.refColumns ?? '');
        lines.push(
          `  ${fk.schema}.${fk.table}(${cols}) -> ${fk.refSchema}.${fk.refTable}(${refCols})`,
        );
      }
    }
    return lines.join('\n');
  }
}

function extractLastSqlBlock(text: string): string | null {
  const re = /```sql\s*\n([\s\S]*?)```/gi;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    last = m[1].trim();
  }
  return last;
}

type ErTable = {
  schema: string;
  name: string;
  columns: { name: string; dataType: string; isPrimaryKey: boolean; nullable: boolean }[];
};
type ErFk = {
  schema: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
};

/**
 * Pick tables likely relevant to the conversation so far. Algorithm:
 *   1. Tokenize the hint text into word-stems (>=3 chars, lowercased).
 *   2. Score each table: hit on exact table name > substring match >
 *      column-name match. Tables mentioned by the user always win.
 *   3. If we have any seeded matches, expand to FK neighbors (1 hop).
 *   4. Fill remaining slots with the largest unmatched tables (by col count).
 * When nothing matches (generic question), we return the first N tables,
 * which preserves previous behaviour.
 */
export function pickRelevantTables(
  er: { tables: ErTable[]; foreignKeys: ErFk[] },
  hintText: string,
  maxTables: number,
): ErTable[] {
  if (er.tables.length <= maxTables) return er.tables;

  const tokens = new Set(
    hintText
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 3),
  );
  const scores = new Map<string, number>();
  const key = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;

  for (const t of er.tables) {
    const nm = t.name.toLowerCase();
    let score = 0;
    if (tokens.has(nm)) score += 100;
    for (const tok of tokens) {
      if (tok === nm) continue;
      if (nm.includes(tok) || tok.includes(nm)) score += 20;
    }
    for (const c of t.columns) {
      if (tokens.has(c.name.toLowerCase())) score += 2;
    }
    if (score > 0) scores.set(key(t), score);
  }

  // FK expansion: 1 hop from any seeded table.
  if (scores.size > 0) {
    const seeded = new Set(scores.keys());
    for (const fk of er.foreignKeys) {
      const a = `${fk.schema}.${fk.table}`;
      const b = `${fk.refSchema}.${fk.refTable}`;
      if (seeded.has(a) && !scores.has(b)) scores.set(b, 5);
      if (seeded.has(b) && !scores.has(a)) scores.set(a, 5);
    }
  }

  const picked: ErTable[] = [];
  if (scores.size > 0) {
    const ranked = er.tables
      .filter((t) => scores.has(key(t)))
      .sort((a, b) => (scores.get(key(b)) ?? 0) - (scores.get(key(a)) ?? 0));
    picked.push(...ranked.slice(0, maxTables));
  }
  // Fall back to first-N when nothing matched, so generic questions still
  // get a schema overview instead of an empty prompt.
  if (picked.length === 0) return er.tables.slice(0, maxTables);
  return picked;
}
