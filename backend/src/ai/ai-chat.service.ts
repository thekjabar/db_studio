import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { ConnectionsService } from '../connections/connections.service';
import { RbacService } from '../rbac/rbac.service';

/**
 * Persistent AI chat: conversation scoped to a connection. Each turn we
 * send the full message history + the connection's schema context to
 * Anthropic, extract any SQL the model proposes, and store both turns.
 *
 * We keep SQL extraction simple: the model is asked to return
 * `` ```sql ... ``` `` fenced blocks. The last SQL block in the assistant
 * message is promoted to `sqlBlock` so the UI can render a "Run" button.
 */
@Injectable()
export class AiChatService {
  private client: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly connections: ConnectionsService,
    private readonly rbac: RbacService,
  ) {
    if (cfg.aiEnabled) this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  }

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
    if (!this.client) {
      throw new ServiceUnavailableException(
        'AI is disabled on this server — set ANTHROPIC_API_KEY to enable.',
      );
    }
    const content = input.content.trim();
    if (!content) throw new BadRequestException('Message required');
    if (content.length > 4000) throw new BadRequestException('Message too long');
    await this.rbac.require(userId, input.connectionId, Role.VIEWER);

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

    // Load schema context — one-time per call, not persisted.
    const drv = await this.connections.buildDriverForRole(input.connectionId, Role.VIEWER);
    let dialect: Dialect;
    let schemaCtx: string;
    try {
      const conn = await this.connections.get(input.connectionId);
      dialect = conn.dialect;
      const er = await drv.introspectForER();
      schemaCtx = this.renderSchemaContext(er);
    } finally {
      await drv.close().catch(() => {});
    }

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

    const system = `You are a careful SQL assistant for a ${dialect} database.
- When appropriate, include exactly one executable SQL statement in a \`\`\`sql fenced block.
- Use ONLY the tables and columns listed below; never invent identifiers.
- Prefer SELECT. Only propose DDL/DML when the user explicitly asks for one.
- For row-limiting SELECTs, include a LIMIT of 100 unless the user asked otherwise.
- You may answer follow-up questions without generating SQL when the user is asking for explanation or clarification.

Schema:
${schemaCtx}`;

    const resp = await this.client.messages.create({
      model: this.cfg.anthropicModel,
      max_tokens: 2048,
      system,
      messages,
    });
    const block = resp.content.find((b) => b.type === 'text');
    const assistantText =
      block && block.type === 'text' ? block.text.trim() : '(no response)';
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

  private renderSchemaContext(er: {
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
  }): string {
    const lines: string[] = [];
    const MAX_TABLES = 60;
    const MAX_COLS_PER_TABLE = 40;
    for (const t of er.tables.slice(0, MAX_TABLES)) {
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
    if (er.tables.length > MAX_TABLES) {
      lines.push(`-- ${er.tables.length - MAX_TABLES} more tables omitted for context length.`);
    }
    if (er.foreignKeys.length) {
      lines.push('');
      lines.push('FOREIGN KEYS:');
      for (const fk of er.foreignKeys.slice(0, 100)) {
        lines.push(
          `  ${fk.schema}.${fk.table}(${fk.columns.join(',')}) -> ${fk.refSchema}.${fk.refTable}(${fk.refColumns.join(',')})`,
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
