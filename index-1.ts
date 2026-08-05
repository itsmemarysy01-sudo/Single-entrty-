/**
 * TeamMarySy Bot — Single-File Entrypoint (v3, TypeScript)
 * Telegram-native · Event-driven · Cloudflare Workers
 *
 * Layout mirrors ARCHITECTURE.md (Transport -> Router -> Handlers -> Modules
 * -> State -> Delivery) as sections within one file for single-file deploy.
 *
 * v3 additions on top of v2:
 *   - Strong typing throughout (no implicit any); ambient KVNamespace /
 *     ExecutionContext types are declared locally so this file has zero
 *     external type dependencies. If you add @cloudflare/workers-types as a
 *     devDependency, these local declarations are safely shadowed by your
 *     tsconfig "types" — nothing here uses `declare global`.
 *   - Payload / schema validation: message + note + ticket text length caps,
 *     callback_data size guard, and a validated schema for scheduled jobs
 *     before they're written to sched:*.
 *   - Correct config caching: a RequestCache instance is created once per
 *     update (or per scheduler run) and threaded through calls, instead of
 *     a module-level cache that could go stale across isolate reuse.
 *
 * Carried over from v2 / hardening pass:
 *   - Audit log (log:*), sequential counters (counter:*)
 *   - Full content lifecycle (draft -> published -> archived, retained)
 *   - Full ticket lifecycle (open -> in_progress -> resolved -> closed)
 *     with assignment, notes, and transition notifications
 *   - Explicit paginated state cleanup job + paginated scheduled-job runner
 *   - Best-effort scheduler lock to avoid duplicate cron processing
 *   - Telegram 429 handling (respects retry_after, bounded retries)
 *   - Timing-safe webhook secret comparison
 *   - toSafeInteger() guard on all callback-derived numeric IDs
 *
 * Required secrets:   TG_BOT_TOKEN, TG_BOT_SECRET_TOKEN
 * Required vars:      OWNER_ID, BOT_USERNAME
 * Required bindings:  KV (Workers KV namespace)
 * Cron:                crons = ["*\/15 * * * *"]
 */

// =====================================================================
// 0. AMBIENT TYPES — self-contained, no external @types dependency
// =====================================================================

interface KVNamespaceListKey {
  name: string;
  expiration?: number;
}

interface KVNamespaceListResult {
  keys: KVNamespaceListKey[];
  list_complete: boolean;
  cursor?: string;
}

interface KVPutOptions {
  expirationTtl?: number;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<KVNamespaceListResult>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  KV: KVNamespace;
  TG_BOT_TOKEN: string;
  TG_BOT_SECRET_TOKEN: string;
  OWNER_ID: string;
  BOT_USERNAME: string;
}

// =====================================================================
// 0.1 TELEGRAM UPDATE TYPES (subset actually used)
// =====================================================================

interface TelegramChat {
  id: number;
  title?: string;
  type?: string;
}

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramChatJoinRequest {
  chat: TelegramChat;
  from: TelegramUser;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  chat_join_request?: TelegramChatJoinRequest;
}

interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

// =====================================================================
// 0.2 DOMAIN TYPES
// =====================================================================

type ContentStatus = "draft" | "published" | "archived";
type TicketStatus = "open" | "in_progress" | "resolved" | "closed";
type ScheduledJobStatus = "pending" | "processing" | "sent" | "failed";

interface ContentItem {
  id: string;
  chat_id: number;
  text: string;
  status: ContentStatus;
  created_at: number;
  updated_at: number;
}

interface TicketNote {
  text: string;
  at: number;
}

interface Ticket {
  id: string;
  chat_id: number;
  user_id: number;
  text: string;
  status: TicketStatus;
  assignee_id: number | null;
  notes: TicketNote[];
  created_at: number;
  updated_at: number;
}

interface ScheduledJob {
  id: string;
  type: "content";
  chat_id: number;
  text: string;
  due_at: number;
  status: ScheduledJobStatus;
  retry_count: number;
  max_retries: number;
}

interface ConversationState {
  flow: string;
  step: string;
  data: Record<string, unknown>;
  expires_at: number;
}

interface AuditLogEntry {
  id: number;
  action: string;
  actor_id: number;
  details: Record<string, unknown>;
  at: number;
}

// =====================================================================
// 0.3 CONSTANTS / KEY NAMESPACES / LIMITS
// =====================================================================

const KV_PREFIX = {
  CONFIG: "config:",
  STATE: "state:",
  CONTENT: "content:",
  TICKET: "ticket:",
  SCHED: "sched:",
  SCHED_FAILED: "sched:failed:",
  COUNTER: "counter:",
  LOG: "log:",
} as const;

const SUPPORTED_COMMANDS = ["/start", "/panel", "/content", "/community", "/support"] as const;
type SupportedCommand = (typeof SUPPORTED_COMMANDS)[number];

const TICKET_STATUSES: TicketStatus[] = ["open", "in_progress", "resolved", "closed"];

const LIMITS = {
  MESSAGE_TEXT_MAX: 4096, // Telegram's own hard limit per sendMessage
  CALLBACK_DATA_MAX: 64, // Telegram's own hard limit on callback_data
  CONTENT_TEXT_MAX: 4096,
  TICKET_TEXT_MAX: 2000,
  NOTE_TEXT_MAX: 1000,
};

class ValidationError extends Error {}

// =====================================================================
// 1. TRANSPORT LAYER — fetch() and scheduled() entrypoints
// =====================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!secretHeader || !timingSafeEqual(secretHeader, env.TG_BOT_SECRET_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update: TelegramUpdate;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const cache = new RequestCache();
    ctx.waitUntil(
      routeUpdate(update, env, cache).catch((err) => {
        console.error("Unhandled routing error:", err);
      })
    );

    return new Response("OK", { status: 200 });
  },

  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledTasks(env));
  },
};

// =====================================================================
// 1.1 REQUEST-SCOPED CACHE
//   Created fresh per update (or per scheduler run) and threaded through
//   calls explicitly. This avoids the correctness risk of a module-level
//   cache going stale across isolate reuse between unrelated invocations.
// =====================================================================

class RequestCache {
  private admins: number[] | null = null;

  async getAdmins(env: Env): Promise<number[]> {
    if (this.admins === null) {
      this.admins = await loadAdminsFromKV(env);
    }
    return this.admins;
  }
}

async function loadAdminsFromKV(env: Env): Promise<number[]> {
  const raw = await env.KV.get(`${KV_PREFIX.CONFIG}admins`);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(Number).filter(Number.isSafeInteger) : [];
  } catch {
    return [];
  }
}

async function isOwnerOrAdmin(userId: number, env: Env, cache: RequestCache): Promise<boolean> {
  if (Number(env.OWNER_ID) === userId) return true;
  const admins = await cache.getAdmins(env);
  return admins.includes(userId);
}

// =====================================================================
// 2. ROUTER
// =====================================================================

async function routeUpdate(update: TelegramUpdate, env: Env, cache: RequestCache): Promise<void> {
  if (update.message) return handleMessage(update.message, env, cache);
  if (update.callback_query) return handleCallback(update.callback_query, env, cache);
  if (update.chat_join_request) return handleJoinRequest(update.chat_join_request, env, cache);
  // Unsupported update types are safely ignored.
}

// =====================================================================
// 3. HANDLERS
// =====================================================================

async function handleMessage(message: TelegramMessage, env: Env, cache: RequestCache): Promise<void> {
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  if (!chatId || !userId) return;

  if (!message.text) {
    if (await Support.isAwaitingText(chatId, env)) {
      await telegram.sendMessage(env, chatId, "Please send your response as text.");
    }
    return;
  }

  if (await Support.isAwaitingText(chatId, env)) {
    return Support.handleTextInput(chatId, userId, message.text, env);
  }

  const { command, args } = normalizeCommand(message.text, env.BOT_USERNAME);
  if (!isSupportedCommand(command)) return;

  switch (command) {
    case "/start":
      await telegram.sendMessage(env, chatId, "Welcome to TeamMarySy Bot. Use /panel to get started.");
      return;
    case "/panel":
      return sendPanel(chatId, env);
    case "/content":
      return Content.showMenu(chatId, env);
    case "/community":
      await telegram.sendMessage(env, chatId, "Community management runs via join-request events.");
      return;
    case "/support":
      return Support.start(chatId, userId, env);
  }
}

function isSupportedCommand(command: string): command is SupportedCommand {
  return (SUPPORTED_COMMANDS as readonly string[]).includes(command);
}

function normalizeCommand(text: string, botUsername: string): { command: string; args: string[] } {
  const trimmed = (text || "").trim();
  const parts = trimmed.split(/\s+/);
  let cmd = parts[0] || "";

  if (botUsername && cmd.toLowerCase().endsWith("@" + botUsername.toLowerCase())) {
    cmd = cmd.slice(0, cmd.length - (botUsername.length + 1));
  } else {
    cmd = cmd.split("@")[0];
  }

  cmd = cmd.toLowerCase();
  const args = parts.slice(1);
  return { command: cmd, args };
}

async function handleCallback(
  callbackQuery: TelegramCallbackQuery,
  env: Env,
  cache: RequestCache
): Promise<void> {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (data.length > LIMITS.CALLBACK_DATA_MAX) {
    // Telegram itself caps callback_data at 64 bytes, so this should never
    // happen from a real client — but a malformed/forged payload shouldn't
    // be trusted just because it parses.
    await telegram.answerCallbackQuery(env, callbackQuery.id, "Invalid request.");
    return;
  }

  let userId: number, safeChatId: number;
  try {
    userId = toSafeInteger(callbackQuery.from?.id);
    safeChatId = toSafeInteger(chatId);
  } catch {
    await telegram.answerCallbackQuery(env, callbackQuery.id, "Invalid request.");
    return;
  }

  const isPrivileged = data.startsWith("menu:") || data.startsWith("join:") || data.startsWith("ticket:");
  if (isPrivileged) {
    const authorized = await isOwnerOrAdmin(userId, env, cache);
    if (!authorized) {
      await telegram.answerCallbackQuery(env, callbackQuery.id, "Not authorized.");
      return;
    }
  }

  await telegram.answerCallbackQuery(env, callbackQuery.id);

  try {
    if (data.startsWith("menu:")) return await handleMenuCallback(data, safeChatId, messageId, env);
    if (data.startsWith("join:")) return await handleJoinCallback(data, safeChatId, messageId, userId, env);
    if (data.startsWith("content:")) return await Content.handleCallback(data, safeChatId, messageId, env);
    if (data.startsWith("ticket:")) return await Support.handleCallback(data, safeChatId, messageId, userId, env);
  } catch (err) {
    console.error("Callback handling error:", err);
    if (safeChatId && messageId) {
      await telegram
        .editMessageText(env, safeChatId, messageId, "Something went wrong processing that action.")
        .catch(() => {});
    }
  }
}

async function handleMenuCallback(
  data: string,
  chatId: number,
  messageId: number | undefined,
  env: Env
): Promise<void> {
  const target = data.split(":")[1];
  switch (target) {
    case "content":
      await Content.showMenu(chatId, env, messageId);
      return;
    case "community":
      await telegram.editMessageText(env, chatId, messageId, "Community management runs via join-request events.");
      return;
    case "support":
      await telegram.editMessageText(env, chatId, messageId, "Use /support to open a ticket.");
      return;
    case "panel":
    default:
      await sendPanel(chatId, env, messageId);
      return;
  }
}

async function handleJoinCallback(
  data: string,
  chatId: number,
  messageId: number | undefined,
  actorId: number,
  env: Env
): Promise<void> {
  // join:approve:<chatId>:<userId> | join:reject:<chatId>:<userId>
  const [, action, rawChatId, rawUserId] = data.split(":");

  let targetChatId: number, targetUserId: number;
  try {
    targetChatId = toSafeInteger(rawChatId);
    targetUserId = toSafeInteger(rawUserId);
  } catch {
    await telegram.editMessageText(env, chatId, messageId, "Invalid join request identifiers.");
    return;
  }

  if (action === "approve") {
    await Community.approve(targetChatId, targetUserId, actorId, env);
    await telegram.editMessageText(env, chatId, messageId, `Approved user ${targetUserId}.`);
    return;
  }
  if (action === "reject") {
    await Community.reject(targetChatId, targetUserId, actorId, env);
    await telegram.editMessageText(env, chatId, messageId, `Rejected user ${targetUserId}.`);
    return;
  }
}

async function handleJoinRequest(
  joinRequest: TelegramChatJoinRequest,
  env: Env,
  cache: RequestCache
): Promise<void> {
  return Community.notify(joinRequest, env, cache);
}

async function sendPanel(chatId: number, env: Env, messageId?: number): Promise<void> {
  const text = "TeamMarySy Bot";
  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [{ text: "\ud83d\udcdd Content", callback_data: "menu:content" }],
      [{ text: "\ud83d\udc65 Community", callback_data: "menu:community" }],
      [{ text: "\ud83c\udfab Support", callback_data: "menu:support" }],
    ],
  };
  if (messageId) {
    await telegram.editMessageText(env, chatId, messageId, text, keyboard);
    return;
  }
  await telegram.sendMessage(env, chatId, text, keyboard);
}

// =====================================================================
// 4. BUSINESS MODULES
// =====================================================================

const Content = {
  async showMenu(chatId: number, env: Env, messageId?: number): Promise<void> {
    const text = "Content Management";
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        [
          { text: "\ud83d\udcdd Create", callback_data: "content:create" },
          { text: "\ud83d\udcda List", callback_data: "content:list" },
        ],
        [{ text: "\ud83d\udce6 Archive", callback_data: "content:list_archived" }],
        [{ text: "\u274c Close", callback_data: "menu:panel" }],
      ],
    };
    if (messageId) {
      await telegram.editMessageText(env, chatId, messageId, text, keyboard);
      return;
    }
    await telegram.sendMessage(env, chatId, text, keyboard);
  },

  async handleCallback(data: string, chatId: number, messageId: number | undefined, env: Env): Promise<void> {
    const parts = data.split(":");
    const action = parts[1];

    switch (action) {
      case "list":
        return this.renderList(chatId, messageId, env, false);
      case "list_archived":
        return this.renderList(chatId, messageId, env, true);
      case "publish": {
        const id = parts[2];
        await this.publishById(id, env);
        await telegram.editMessageText(env, chatId, messageId, `Content ${id} published.`);
        return;
      }
      case "archive": {
        const id = parts[2];
        await this.archive(id, env);
        await telegram.editMessageText(env, chatId, messageId, `Content ${id} archived.`);
        return;
      }
      case "create":
        // Draft creation via inline chat input is not yet wired to a
        // text-collection state machine. Content.create() is available as
        // a direct API for programmatic/scheduled use in the meantime.
        await telegram.editMessageText(env, chatId, messageId, "Draft creation via chat input is not implemented yet.");
        return;
      default:
        await telegram.editMessageText(env, chatId, messageId, `Unknown content action: ${action}`);
    }
  },

  /** Creates a draft. Does not publish or notify. */
  async create(chatId: number, text: string, env: Env): Promise<ContentItem> {
    assertValidText(text, LIMITS.CONTENT_TEXT_MAX, "Content text");
    const id = await nextId(env, "content");
    const item: ContentItem = {
      id: String(id),
      chat_id: chatId,
      text,
      status: "draft",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await env.KV.put(`${KV_PREFIX.CONTENT}${item.id}`, JSON.stringify(item));
    return item;
  },

  /** Lists content by status. Archived items are excluded from active listings by default. */
  async list(env: Env, { archived = false, limit = 20 }: { archived?: boolean; limit?: number } = {}): Promise<ContentItem[]> {
    const result = await env.KV.list({ prefix: KV_PREFIX.CONTENT, limit });
    const items: ContentItem[] = [];
    for (const key of result.keys) {
      const raw = await env.KV.get(key.name);
      if (!raw) continue;
      const item: ContentItem = JSON.parse(raw);
      const isArchived = item.status === "archived";
      if (archived ? isArchived : !isArchived) items.push(item);
    }
    return items;
  },

  async renderList(chatId: number, messageId: number | undefined, env: Env, archived: boolean): Promise<void> {
    const items = await this.list(env, { archived });
    if (items.length === 0) {
      await telegram.editMessageText(env, chatId, messageId, archived ? "No archived content." : "No active content.");
      return;
    }
    const lines = items.map((i) => `#${i.id} [${i.status}] ${i.text.slice(0, 40)}`);
    await telegram.editMessageText(env, chatId, messageId, lines.join("\n"));
  },

  async publishById(id: string, env: Env): Promise<void> {
    const key = `${KV_PREFIX.CONTENT}${id}`;
    const raw = await env.KV.get(key);
    if (!raw) throw new Error(`Content.publishById: ${id} not found`);
    const item: ContentItem = JSON.parse(raw);
    await this.publish(item, env);
    await env.KV.put(key, JSON.stringify({ ...item, status: "published", updated_at: Date.now() } as ContentItem));
  },

  /**
   * Publishing contract: the Scheduler calls this directly for time-based
   * jobs; interactive publish calls (publishById) reuse the same function,
   * so both paths deliver identically.
   */
  async publish(item: Pick<ContentItem, "id" | "chat_id" | "text">, env: Env): Promise<void> {
    if (!item.chat_id || !item.text) {
      throw new Error(`Content.publish: invalid item ${item.id}`);
    }
    await telegram.sendMessage(env, item.chat_id, item.text);
  },

  /** Archives content. Retained in KV — never deleted — per retention policy. */
  async archive(id: string, env: Env): Promise<void> {
    const key = `${KV_PREFIX.CONTENT}${id}`;
    const raw = await env.KV.get(key);
    if (!raw) throw new Error(`Content.archive: ${id} not found`);
    const item: ContentItem = JSON.parse(raw);
    await env.KV.put(key, JSON.stringify({ ...item, status: "archived", updated_at: Date.now() } as ContentItem));
  },

  /** Enqueues a validated content job for the Scheduler to publish later. */
  async schedule(chatId: number, text: string, dueAt: number, env: Env, maxRetries = 3): Promise<ScheduledJob> {
    assertValidText(text, LIMITS.CONTENT_TEXT_MAX, "Content text");
    const id = String(await nextId(env, "sched"));
    const job: ScheduledJob = {
      id,
      type: "content",
      chat_id: chatId,
      text,
      due_at: dueAt,
      status: "pending",
      retry_count: 0,
      max_retries: maxRetries,
    };
    assertValidScheduledJob(job);
    await env.KV.put(`${KV_PREFIX.SCHED}${id}`, JSON.stringify(job));
    return job;
  },
};

const Community = {
  async notify(joinRequest: TelegramChatJoinRequest, env: Env, cache: RequestCache): Promise<void> {
    const chat = joinRequest.chat;
    const from = joinRequest.from;
    const admins = await cache.getAdmins(env);
    const ownerId = Number(env.OWNER_ID);
    const recipients = [...new Set([ownerId, ...admins])].filter(Number.isSafeInteger);

    const text = `Join request for ${chat.title || chat.id}\nUser: ${from.first_name || ""} (${from.id})`;
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        [
          { text: "\u2705 Approve", callback_data: `join:approve:${chat.id}:${from.id}` },
          { text: "\u274c Reject", callback_data: `join:reject:${chat.id}:${from.id}` },
        ],
      ],
    };

    await Promise.all(recipients.map((adminId) => telegram.sendMessage(env, adminId, text, keyboard)));
  },

  async approve(chatId: number, userId: number, actorId: number, env: Env): Promise<void> {
    await telegram.approveChatJoinRequest(env, chatId, userId);
    await writeAuditLog(env, "join_approved", actorId, { chat_id: chatId, user_id: userId });
  },

  async reject(chatId: number, userId: number, actorId: number, env: Env): Promise<void> {
    await telegram.declineChatJoinRequest(env, chatId, userId);
    await writeAuditLog(env, "join_rejected", actorId, { chat_id: chatId, user_id: userId });
  },
};

const Support = {
  STATE_TTL_MS: 15 * 60 * 1000, // 15 minutes

  stateKey(chatId: number): string {
    return `${KV_PREFIX.STATE}${chatId}:support`;
  },

  ticketKey(id: string): string {
    return `${KV_PREFIX.TICKET}${id}`;
  },

  async start(chatId: number, userId: number, env: Env): Promise<void> {
    const state: ConversationState = {
      flow: "support",
      step: "awaiting_ticket_text",
      data: { user_id: userId },
      expires_at: Date.now() + this.STATE_TTL_MS,
    };
    await env.KV.put(this.stateKey(chatId), JSON.stringify(state), {
      expirationTtl: Math.ceil(this.STATE_TTL_MS / 1000),
    });
    await telegram.sendMessage(env, chatId, "Please describe your issue. Send it as a text message.");
  },

  async isAwaitingText(chatId: number, env: Env): Promise<boolean> {
    const raw = await env.KV.get(this.stateKey(chatId));
    if (!raw) return false;
    try {
      const state: ConversationState = JSON.parse(raw);
      return state.step === "awaiting_ticket_text" && state.expires_at > Date.now();
    } catch {
      return false;
    }
  },

  async handleTextInput(chatId: number, userId: number, text: string, env: Env): Promise<void> {
    if (text.length > LIMITS.TICKET_TEXT_MAX) {
      await telegram.sendMessage(
        env,
        chatId,
        `That's too long (max ${LIMITS.TICKET_TEXT_MAX} characters). Please shorten it and resend.`
      );
      return; // state stays active so the user can retry
    }

    const id = String(await nextId(env, "ticket"));
    const ticket: Ticket = {
      id,
      chat_id: chatId,
      user_id: userId,
      text,
      status: "open",
      assignee_id: null,
      notes: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await env.KV.put(this.ticketKey(ticket.id), JSON.stringify(ticket));
    await env.KV.delete(this.stateKey(chatId));
    await telegram.sendMessage(env, chatId, `Ticket #${ticket.id} created. We'll get back to you.`);
  },

  async get(id: string, env: Env): Promise<Ticket | null> {
    const raw = await env.KV.get(this.ticketKey(id));
    return raw ? JSON.parse(raw) : null;
  },

  async assign(id: string, adminId: number, env: Env): Promise<Ticket> {
    const ticket = await this.get(id, env);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    ticket.assignee_id = adminId;
    ticket.updated_at = Date.now();
    await env.KV.put(this.ticketKey(id), JSON.stringify(ticket));
    return ticket;
  },

  async addNote(id: string, note: string, env: Env): Promise<Ticket> {
    assertValidText(note, LIMITS.NOTE_TEXT_MAX, "Note");
    const ticket = await this.get(id, env);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    ticket.notes.push({ text: note, at: Date.now() });
    ticket.updated_at = Date.now();
    await env.KV.put(this.ticketKey(id), JSON.stringify(ticket));
    return ticket;
  },

  /** Transitions status and notifies the ticket's originating chat. */
  async setStatus(id: string, status: TicketStatus, env: Env): Promise<Ticket> {
    if (!TICKET_STATUSES.includes(status)) {
      throw new Error(`Invalid ticket status: ${status}`);
    }
    const ticket = await this.get(id, env);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    ticket.status = status;
    ticket.updated_at = Date.now();
    await env.KV.put(this.ticketKey(id), JSON.stringify(ticket));

    const labels: Record<TicketStatus, string> = {
      open: "opened",
      in_progress: "in progress",
      resolved: "resolved",
      closed: "closed",
    };
    await telegram.sendMessage(env, ticket.chat_id, `Your ticket #${id} is now ${labels[status]}.`);
    return ticket;
  },

  async handleCallback(
    data: string,
    chatId: number,
    messageId: number | undefined,
    adminId: number,
    env: Env
  ): Promise<void> {
    // ticket:<action>:<id>
    const [, action, id] = data.split(":");
    switch (action) {
      case "assign":
        await this.assign(id, adminId, env);
        await telegram.editMessageText(env, chatId, messageId, `Ticket #${id} assigned to ${adminId}.`);
        return;
      case "in_progress":
      case "resolved":
      case "closed":
        await this.setStatus(id, action, env);
        await telegram.editMessageText(env, chatId, messageId, `Ticket #${id} marked ${action}.`);
        return;
      default:
        await telegram.editMessageText(env, chatId, messageId, `Unknown ticket action: ${action}`);
    }
  },
};

// =====================================================================
// 5. STATE LAYER — validation, counters, audit log
// =====================================================================

/** src/utils/validate.js equivalent. Throws on anything not a safe integer. */
function toSafeInteger(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new ValidationError(`Invalid numeric identifier: ${String(value)}`);
  }
  return n;
}

function assertValidText(text: unknown, maxLength: number, label: string): asserts text is string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (text.length > maxLength) {
    throw new ValidationError(`${label} exceeds ${maxLength} characters`);
  }
}

function assertValidScheduledJob(job: ScheduledJob): void {
  if (job.type !== "content") throw new ValidationError(`Unsupported scheduled job type: ${job.type}`);
  if (!Number.isSafeInteger(job.chat_id)) throw new ValidationError("Scheduled job chat_id must be a safe integer");
  assertValidText(job.text, LIMITS.CONTENT_TEXT_MAX, "Scheduled job text");
  if (!Number.isFinite(job.due_at) || job.due_at <= 0) throw new ValidationError("Scheduled job due_at must be a positive timestamp");
  if (!Number.isInteger(job.max_retries) || job.max_retries < 1) throw new ValidationError("Scheduled job max_retries must be a positive integer");
}

/** Sequential ID generator backing counter:* (used for content, tickets, log entries, and scheduled jobs). */
async function nextId(env: Env, name: string): Promise<number> {
  const key = `${KV_PREFIX.COUNTER}${name}`;
  const raw = await env.KV.get(key);
  const current = raw ? parseInt(raw, 10) : 0;
  const next = current + 1;
  await env.KV.put(key, String(next));
  return next;
}

/** Append-only audit trail for moderation accountability (log:*). */
async function writeAuditLog(
  env: Env,
  action: string,
  actorId: number,
  details: Record<string, unknown>
): Promise<AuditLogEntry> {
  const id = await nextId(env, "log");
  const entry: AuditLogEntry = { id, action, actor_id: actorId, details, at: Date.now() };
  await env.KV.put(`${KV_PREFIX.LOG}${id}`, JSON.stringify(entry));
  return entry;
}

// =====================================================================
// 6. SCHEDULER
// =====================================================================

const SCHEDULER_LOCK_KEY = `${KV_PREFIX.CONFIG}scheduler_lock`;
const SCHEDULER_LOCK_TTL_SECONDS = 60; // shorter than the 15-minute cron interval

async function runScheduledTasks(env: Env): Promise<void> {
  const acquired = await acquireSchedulerLock(env);
  if (!acquired) {
    console.log("Scheduler run skipped: previous invocation still holds the lock.");
    return;
  }
  try {
    await processPendingJobs(env);
    await cleanExpiredState(env);
  } finally {
    await env.KV.delete(SCHEDULER_LOCK_KEY).catch(() => {});
  }
}

/**
 * Lightweight lock to prevent duplicate processing if two cron invocations
 * overlap. KV has no atomic compare-and-swap, so this is best-effort, not a
 * strict mutex — acceptable here because job processing guards re-entry via
 * status transitions ("pending" -> "processing" -> "sent"/"failed").
 */
async function acquireSchedulerLock(env: Env): Promise<boolean> {
  const existing = await env.KV.get(SCHEDULER_LOCK_KEY);
  if (existing) return false;
  await env.KV.put(SCHEDULER_LOCK_KEY, String(Date.now()), { expirationTtl: SCHEDULER_LOCK_TTL_SECONDS });
  return true;
}

async function processPendingJobs(env: Env): Promise<void> {
  const now = Date.now();
  let cursor: string | undefined;

  do {
    const page = await env.KV.list({ prefix: KV_PREFIX.SCHED, cursor, limit: 100 });
    cursor = page.list_complete ? undefined : page.cursor;

    for (const key of page.keys) {
      if (key.name.startsWith(KV_PREFIX.SCHED_FAILED)) continue;
      await processOneJob(key.name, now, env);
    }
  } while (cursor);
}

async function processOneJob(keyName: string, now: number, env: Env): Promise<void> {
  const raw = await env.KV.get(keyName);
  if (!raw) return;

  let item: ScheduledJob;
  try {
    item = JSON.parse(raw);
    assertValidScheduledJob(item);
  } catch (err) {
    console.error(`Dropping malformed scheduled job ${keyName}:`, err);
    await env.KV.delete(keyName);
    return;
  }

  if (item.status !== "pending" || item.due_at > now) return;

  try {
    await env.KV.put(keyName, JSON.stringify({ ...item, status: "processing" } as ScheduledJob));
    await Content.publish(item, env);
    await env.KV.put(keyName, JSON.stringify({ ...item, status: "sent" } as ScheduledJob));
  } catch (err) {
    console.error(`Scheduled task failed for ${keyName}:`, err);
    const retryCount = item.retry_count + 1;

    if (retryCount >= item.max_retries) {
      await env.KV.put(
        `${KV_PREFIX.SCHED_FAILED}${item.id}`,
        JSON.stringify({ ...item, status: "failed", retry_count: retryCount } as ScheduledJob)
      );
      await env.KV.delete(keyName);
    } else {
      await env.KV.put(keyName, JSON.stringify({ ...item, status: "pending", retry_count: retryCount } as ScheduledJob));
    }
  }
}

/**
 * Explicit "clean temporary state" job. KV's own expirationTtl already
 * reaps state:* entries, but this pass catches anything created without a
 * TTL and enforces minimal-persistence deterministically. Paginates via
 * cursor per spec.
 */
async function cleanExpiredState(env: Env): Promise<void> {
  const now = Date.now();
  let cursor: string | undefined;

  do {
    const page = await env.KV.list({ prefix: KV_PREFIX.STATE, cursor, limit: 100 });
    cursor = page.list_complete ? undefined : page.cursor;

    for (const key of page.keys) {
      const raw = await env.KV.get(key.name);
      if (!raw) continue;
      try {
        const state: ConversationState = JSON.parse(raw);
        if (state.expires_at && state.expires_at <= now) {
          await env.KV.delete(key.name);
        }
      } catch {
        await env.KV.delete(key.name); // malformed state entry — safe to drop
      }
    }
  } while (cursor);
}

// =====================================================================
// 7. DELIVERY LAYER
// =====================================================================

interface TelegramApiError {
  ok: false;
  error_code: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface TelegramApiSuccess<T> {
  ok: true;
  result: T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Constant-time string comparison, used for the webhook secret header, to
 * avoid leaking how many leading bytes matched via response timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a || "");
  const bBytes = enc.encode(b || "");
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

const telegram = {
  MAX_RATE_LIMIT_RETRIES: 3,

  async _call<T>(env: Env, method: string, payload: Record<string, unknown>, attempt = 0): Promise<T> {
    const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data: TelegramApiSuccess<T> | TelegramApiError = await res.json();

    if (res.status === 429 || (!data.ok && data.error_code === 429)) {
      const retryAfterSeconds = (!data.ok ? data.parameters?.retry_after : undefined) ?? 1;
      if (attempt >= this.MAX_RATE_LIMIT_RETRIES) {
        throw new Error(`Telegram API rate limited (${method}) after ${attempt} retries`);
      }
      await sleep(retryAfterSeconds * 1000);
      return this._call<T>(env, method, payload, attempt + 1);
    }

    if (!res.ok || !data.ok) {
      const description = !data.ok ? data.description : res.statusText;
      throw new Error(`Telegram API error (${method}): ${description || res.status}`);
    }
    return data.result;
  },

  async sendMessage(env: Env, chatId: number, text: string, replyMarkup?: InlineKeyboard): Promise<unknown> {
    assertValidText(text, LIMITS.MESSAGE_TEXT_MAX, "Message text");
    return this._call(env, "sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
  },

  async editMessageText(
    env: Env,
    chatId: number,
    messageId: number | undefined,
    text: string,
    replyMarkup?: InlineKeyboard
  ): Promise<unknown> {
    assertValidText(text, LIMITS.MESSAGE_TEXT_MAX, "Message text");
    return this._call(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup });
  },

  async answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<unknown> {
    return this._call(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  },

  async approveChatJoinRequest(env: Env, chatId: number, userId: number): Promise<unknown> {
    return this._call(env, "approveChatJoinRequest", { chat_id: chatId, user_id: userId });
  },

  async declineChatJoinRequest(env: Env, chatId: number, userId: number): Promise<unknown> {
    return this._call(env, "declineChatJoinRequest", { chat_id: chatId, user_id: userId });
  },
};
