/**
 * Long-polling worker for the Telegram bot. Run with `npm run bot`.
 *
 * Reads the bot token + allowed chat IDs from Settings on boot, then polls
 * Telegram's getUpdates and routes each message/callback to either the LLM
 * agent or a button-driven expense-confirmation flow.
 */
import "dotenv/config";
import path from "node:path";
import { promises as fs } from "node:fs";
import { prisma } from "../src/lib/db";
import * as tg from "../src/lib/telegram";
import { runAgentTurn, resetConversation } from "../src/lib/agent/run";
import { computeQuarterReport, quarterOf } from "../src/lib/tax";
import { monthlyTotals } from "../src/lib/dashboard-data";
import { formatEUR } from "../src/lib/money";
import { parseExpensePdf } from "../src/lib/expense-parser";
import { transcribeVoice } from "../src/lib/voice-transcribe";
import { dueReminders, markSent, upcomingDeadlines } from "../src/lib/reminders";
import { applyDeduction, defaultDeductiblePct } from "../src/lib/deduction";
import { EXPENSE_CATEGORIES } from "../src/lib/expense-parser";
import type { ExpenseCategory } from "@prisma/client";
import { consumePending } from "../src/lib/agent/pending";
import {
  executeUpdateExpense,
  executeDeleteExpense,
  executeUpdateInvoice,
  executeDeleteInvoice,
  type UpdateExpenseArgs,
  type UpdateInvoiceAgentArgs,
} from "../src/lib/agent/mutations";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

async function loadConfig(): Promise<{ token: string; allowedChatIds: Set<string> }> {
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!s?.telegramBotToken) {
    throw new Error(
      "telegramBotToken not set in Settings. Open the Settings page and paste your @BotFather token."
    );
  }
  const allowed = (s.telegramAllowedChatIds ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (allowed.length === 0) {
    throw new Error(
      "telegramAllowedChatIds is empty. Set at least one Telegram user ID in Settings."
    );
  }
  return { token: s.telegramBotToken, allowedChatIds: new Set(allowed) };
}

// Build marker — if this string doesn't appear in your `npm run bot` output,
// you're running stale code and the mutation gate isn't installed. Restart!
const BUILD_TAG = "v2-mutation-gate";

// Slash commands shown in Telegram's "/" autocomplete and Menu button.
// Order here is the order users see — most-used first.
const BOT_COMMANDS: tg.BotCommand[] = [
  { command: "quarter", description: "Current quarter: income, deductible, IRPF owed" },
  { command: "year", description: "This year: monthly income + deductible breakdown" },
  { command: "expenses", description: "Last 10 expenses" },
  { command: "invoices", description: "Last 10 invoices" },
  { command: "remind", description: "Upcoming Spanish autónomo deadlines" },
  { command: "help", description: "What I can do" },
  { command: "reset", description: "Clear conversation memory" },
];

async function main() {
  const { token, allowedChatIds } = await loadConfig();
  const me = await tg.getMe(token);
  try {
    await tg.setMyCommands(token, BOT_COMMANDS);
  } catch (err) {
    console.warn("[bot] setMyCommands failed:", err);
  }
  console.log(`[bot] ===== ${BUILD_TAG} =====`);
  console.log(`[bot] logged in as @${me.username} (id ${me.id})`);
  console.log(`[bot] allow-listed chat ids: ${Array.from(allowedChatIds).join(", ")}`);
  console.log(`[bot] mutation gate: ON  (update/delete actions require user tap-to-confirm)`);
  console.log(`[bot] message formatting: HTML  ·  voice: gpt-4o-mini-transcribe`);
  console.log(`[bot] reminders: hourly check (DM goes to ${[...allowedChatIds][0]})`);
  console.log(`[bot] polling for updates...`);

  // Start the reminder scheduler — hourly check that delivers any due
  // deadline notification to the first allow-listed chat. Boot fires
  // immediately so reminders missed during downtime catch up.
  const reminderChatId = Number([...allowedChatIds][0]);
  if (Number.isFinite(reminderChatId)) {
    void checkReminders(token, reminderChatId);
    setInterval(() => { void checkReminders(token, reminderChatId); }, 60 * 60 * 1000);
  }

  let offset: number | undefined;
  while (true) {
    let updates: tg.TelegramUpdate[];
    try {
      updates = await tg.getUpdates(token, offset, 25);
    } catch (err) {
      console.error("[bot] getUpdates failed:", err);
      await sleep(3000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try {
        if (u.callback_query) {
          await handleCallback(token, allowedChatIds, u.callback_query);
        } else {
          const msg = u.message ?? u.edited_message;
          if (msg) await handleMessage(token, allowedChatIds, msg);
        }
      } catch (err) {
        console.error(`[bot] handler error for update ${u.update_id}:`, err);
        const chat = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
        if (chat != null) {
          try {
            await tg.sendMessage(token, chat, `⚠️ Something broke: ${err instanceof Error ? err.message : String(err)}`);
          } catch {
            // swallow secondary failure
          }
        }
      }
    }
  }
}

// ---- Slash-command quick actions (bypass the LLM for speed) ----

async function sendHelp(token: string, chatId: number): Promise<void> {
  const lines = [
    "<b>Solo Gestoría bot</b>",
    "",
    "<b>Quick actions</b>",
    "/quarter — current quarter: income, deductible, IRPF owed",
    "/year — monthly breakdown for this year",
    "/expenses — last 10 expenses",
    "/invoices — last 10 invoices",
    "/remind — upcoming deadlines",
    "",
    "<b>Conversation</b>",
    "Just type or speak — I have tools to query data, create invoices, recategorize expenses, and download PDFs.",
    "Examples:",
    "• <i>How much tax do I owe this quarter?</i>",
    "• <i>Create an invoice for June, 65 hours at €60.</i>",
    "• <i>Recategorize the Barcelona waste fee to other deductible.</i>",
    "",
    "<b>Other</b>",
    "Send a PDF receipt — I parse it and ask you to confirm.",
    "Send a voice note — I transcribe and run it as a normal message.",
    "/reset — clear chat memory",
  ];
  await tg.sendMessage(token, chatId, lines.join("\n"), { parse_mode: "HTML" });
}

async function sendQuarterSummary(token: string, chatId: number): Promise<void> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const q = quarterOf(now);
  const r = await computeQuarterReport(year, q);
  const lines = [
    `📊 <b>${year} Q${q}</b>`,
    "",
    `Income: <b>${formatEUR(r.period.incomeCents)}</b>`,
    `Deductible (net): <b>${formatEUR(r.period.deductibleNetCents)}</b>`,
    `Deductible (VAT): <b>${formatEUR(r.period.deductibleVatCents)}</b>`,
    "",
    `<b>MOD 130</b> payment this quarter: <b>${formatEUR(r.mod130.box07)}</b>  (YTD net €${(r.mod130.box03 / 100).toFixed(2)}, 20% = €${(r.mod130.box04 / 100).toFixed(2)})`,
    `<b>MOD 303</b> a compensar: <b>${formatEUR(r.mod303.box72)}</b>`,
    `<b>MOD 349</b> ops: ${r.mod349.length}, base €${(r.mod349.reduce((s, o) => s + o.baseCents, 0) / 100).toFixed(2)}`,
  ];
  await tg.sendMessage(token, chatId, lines.join("\n"), { parse_mode: "HTML" });
}

async function sendYearSummary(token: string, chatId: number): Promise<void> {
  const year = new Date().getUTCFullYear();
  const months = await monthlyTotals(year);
  const totalInc = months.reduce((s, m) => s + m.incomeCents, 0);
  const totalDed = months.reduce((s, m) => s + m.totalDeductibleCents, 0);
  const rows = months
    .filter((m) => m.incomeCents > 0 || m.totalDeductibleCents > 0)
    .map((m) => {
      const inc = (m.incomeCents / 100).toFixed(2).padStart(10);
      const ded = (m.totalDeductibleCents / 100).toFixed(2).padStart(8);
      return `${m.label}: €${inc}  ded €${ded}`;
    });
  const text = [
    `📅 <b>${year} monthly breakdown</b>`,
    "",
    "<pre>" + tg.escapeHtml(rows.join("\n")) + "</pre>",
    "",
    `Total income: <b>${formatEUR(totalInc)}</b>`,
    `Total deductible: <b>${formatEUR(totalDed)}</b>`,
  ].join("\n");
  await tg.sendMessage(token, chatId, text, { parse_mode: "HTML" });
}

async function sendRecentExpenses(token: string, chatId: number): Promise<void> {
  const expenses = await prisma.expense.findMany({
    orderBy: { date: "desc" },
    take: 10,
  });
  if (expenses.length === 0) {
    await tg.sendMessage(token, chatId, "No expenses recorded yet.");
    return;
  }
  const rows = expenses.map((e) => {
    const d = e.date.toISOString().slice(0, 10);
    const ded = e.deductibleNetCents + e.deductibleVatCents;
    const status = e.status === "CONFIRMED" ? "✓" : "⏳";
    return `${status} ${d}  ${e.vendor.slice(0, 26).padEnd(26)}  €${(e.grossCents / 100).toFixed(2).padStart(8)}  (${(ded / 100).toFixed(2)} ded)`;
  });
  const text = [
    "<b>Last 10 expenses</b>",
    "",
    "<pre>" + tg.escapeHtml(rows.join("\n")) + "</pre>",
  ].join("\n");
  await tg.sendMessage(token, chatId, text, { parse_mode: "HTML" });
}

async function sendRecentInvoices(token: string, chatId: number): Promise<void> {
  const invoices = await prisma.invoice.findMany({
    orderBy: { date: "desc" },
    take: 10,
    include: { client: { select: { name: true } } },
  });
  if (invoices.length === 0) {
    await tg.sendMessage(token, chatId, "No invoices yet. Tell me 'create invoice for ...'.");
    return;
  }
  const rows = invoices.map((i) => {
    const d = i.date.toISOString().slice(0, 10);
    return `${i.number}  ${d}  ${i.client.name.slice(0, 20).padEnd(20)}  €${(i.totalCents / 100).toFixed(2).padStart(10)}`;
  });
  const text = [
    "<b>Last 10 invoices</b>",
    "",
    "<pre>" + tg.escapeHtml(rows.join("\n")) + "</pre>",
  ].join("\n");
  await tg.sendMessage(token, chatId, text, { parse_mode: "HTML" });
}

// ---- Reminder scheduler ----

async function checkReminders(token: string, chatId: number): Promise<void> {
  try {
    const reminders = await dueReminders();
    for (const r of reminders) {
      await tg.sendMessage(token, chatId, r.text, { parse_mode: "HTML" });
      await markSent(r.kind, r.refKey);
      console.log(`[bot] reminder sent: ${r.kind} ${r.refKey}`);
    }
  } catch (err) {
    console.error("[bot] reminder check failed:", err);
  }
}

async function handleRemindCommand(
  token: string,
  chatId: number,
  text: string
): Promise<void> {
  const arg = text.replace(/^\/remind\s*/i, "").trim().toLowerCase();
  // /remind check  — run the scheduler now and deliver anything pending
  if (arg === "check" || arg === "now") {
    await checkReminders(token, chatId);
    await tg.sendMessage(token, chatId, "🔁 Reminder check ran. Anything due was just sent above.");
    return;
  }
  // /remind clear  — wipe SentReminder so reminders fire again (debugging)
  if (arg === "clear") {
    const { count } = await prisma.sentReminder.deleteMany({});
    await tg.sendMessage(token, chatId, `🧹 Cleared ${count} reminder history entries.`);
    return;
  }
  // /remind  (no args) → show upcoming deadlines
  const upcoming = upcomingDeadlines();
  const lines = [
    `📅 <b>Upcoming deadlines</b>`,
    "",
    ...upcoming.map(
      (d) => `· <b>${d.date}</b> · ${tg.escapeHtml(d.label)}  <i>(${d.daysAway}d)</i>`
    ),
    "",
    `<i>I check every hour and DM you on quarter-end, T-7, and T-2.</i>`,
    `<i>Use </i><code>/remind check</code><i> to force a run, </i><code>/remind clear</code><i> to reset history.</i>`,
  ];
  await tg.sendMessage(token, chatId, lines.join("\n"), { parse_mode: "HTML" });
}

// ---- Typing keepalive ----

// Telegram's typing status expires after 5 seconds OR when the bot sends a
// message — whichever comes first. For longer ops we just resend periodically.
// https://core.telegram.org/bots/api#sendchataction
function startTyping(token: string, chatId: number): () => void {
  const send = () => tg.sendChatAction(token, chatId, "typing").catch(() => {});
  send();                                       // fire and forget — don't delay the reply
  const interval = setInterval(send, 4000);     // refresh well before the 5-sec timeout
  return () => clearInterval(interval);
}

// ---- Message handling ----

async function handleMessage(
  token: string,
  allowed: Set<string>,
  msg: tg.TelegramMessage
): Promise<void> {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id ?? chatId;
  if (!allowed.has(String(fromId)) && !allowed.has(String(chatId))) {
    console.warn(`[bot] denied chat=${chatId} from=${fromId}`);
    await tg.sendMessage(token, chatId, "🔒 Not authorized.");
    return;
  }

  const cmd = msg.text?.trim().toLowerCase();
  if (cmd === "/reset") {
    await resetConversation(chatId);
    await tg.sendMessage(token, chatId, "🧹 Conversation reset. Fresh start.");
    return;
  }
  if (cmd === "/start" || cmd === "/help" || cmd === "/menu") {
    await sendHelp(token, chatId);
    return;
  }
  if (cmd?.startsWith("/remind")) {
    await handleRemindCommand(token, chatId, msg.text!.trim());
    return;
  }
  if (cmd === "/quarter" || cmd === "/q") {
    await sendQuarterSummary(token, chatId);
    return;
  }
  if (cmd === "/year" || cmd === "/y") {
    await sendYearSummary(token, chatId);
    return;
  }
  if (cmd === "/expenses") {
    await sendRecentExpenses(token, chatId);
    return;
  }
  if (cmd === "/invoices") {
    await sendRecentInvoices(token, chatId);
    return;
  }

  // PDF document upload → expense parser + inline-button confirmation.
  if (msg.document && (msg.document.mime_type === "application/pdf" || msg.document.file_name?.toLowerCase().endsWith(".pdf"))) {
    await handlePdfDocument(token, chatId, msg);
    return;
  }

  // Voice message → transcribe → feed to agent as if it were typed.
  if (msg.voice) {
    await handleVoiceMessage(token, chatId, msg);
    return;
  }

  const text = msg.text ?? msg.caption;
  if (!text) {
    await tg.sendMessage(
      token,
      chatId,
      "I can handle text, voice messages, and PDF uploads. Other media isn't wired up yet."
    );
    return;
  }

  const stopTyping = startTyping(token, chatId);
  const t0 = Date.now();
  try {
    const result = await runAgentTurn({
      chatId,
      telegramToken: token,
      userMessage: text,
    });
    console.log(`[bot] chat ${chatId}: ${result.toolCallCount} tool calls in ${Date.now() - t0}ms`);
    if (result.text.trim().length > 0) {
      // The agent often emits Markdown (**bold**, `code`) despite the HTML
      // instruction. Coerce to HTML before sending so it renders correctly.
      const html = tg.markdownToTelegramHtml(result.text);
      await tg.sendMessage(token, chatId, html, { parse_mode: "HTML" });
    }
  } finally {
    stopTyping();
  }
}

// ---- Voice message → Whisper transcription → agent ----

async function handleVoiceMessage(
  token: string,
  chatId: number,
  msg: tg.TelegramMessage
): Promise<void> {
  if (!msg.voice) return;
  const stopTyping = startTyping(token, chatId);
  try {
    const file = await tg.getFile(token, msg.voice.file_id);
    if (!file.file_path) throw new Error("Telegram getFile returned no path");
    const audio = await tg.downloadFile(token, file.file_path);
    const transcript = await transcribeVoice({
      audio,
      mimeType: msg.voice.mime_type ?? "audio/ogg",
      // No language hint — gpt-4o-mini-transcribe auto-detects ES/EN reliably.
    });
    console.log(
      `[bot] voice transcribed (${msg.voice.duration}s, ${transcript.model}, ${transcript.durationMs}ms): "${transcript.text.slice(0, 80)}"`
    );
    const heard = transcript.text.trim();
    if (heard.length === 0) {
      await tg.sendMessage(
        token,
        chatId,
        "🎙️ I couldn't hear anything in that voice note. Try again?"
      );
      return;
    }
    // Show the transcription as a quote so the user can spot mis-hears.
    await tg.sendMessage(
      token,
      chatId,
      `🎙️ <i>Heard:</i> <blockquote>${tg.escapeHtml(heard)}</blockquote>`,
      { parse_mode: "HTML" }
    );
    const t0 = Date.now();
    const result = await runAgentTurn({
      chatId,
      telegramToken: token,
      userMessage: heard,
    });
    console.log(`[bot] chat ${chatId} (voice): ${result.toolCallCount} tool calls in ${Date.now() - t0}ms`);
    if (result.text.trim().length > 0) {
      const html = tg.markdownToTelegramHtml(result.text);
      await tg.sendMessage(token, chatId, html, { parse_mode: "HTML" });
    }
  } finally {
    stopTyping();
  }
}

// ---- PDF document → expense → confirmation buttons ----

async function handlePdfDocument(
  token: string,
  chatId: number,
  msg: tg.TelegramMessage
): Promise<void> {
  if (!msg.document) return;
  const stopTyping = startTyping(token, chatId);
  try {
    const file = await tg.getFile(token, msg.document.file_id);
    if (!file.file_path) throw new Error("Telegram getFile returned no path");
    const buffer = await tg.downloadFile(token, file.file_path);

    const parsed = await parseExpensePdf({
      pdfBuffer: buffer,
      filename: msg.document.file_name ?? "telegram.pdf",
    });

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) throw new Error("Settings missing");
    const date = safeDate(parsed.date) ?? new Date();
    const pct = defaultDeductiblePct(parsed.suggestedCategory, settings, date);
    const ded = applyDeduction(pct, parsed.netBaseCents, parsed.vatCents);

    await fs.mkdir(path.join(UPLOAD_DIR, "expenses"), { recursive: true });
    const expenseId = crypto.randomUUID();
    const relPath = path.join("expenses", `${expenseId}.pdf`);
    await fs.writeFile(path.join(UPLOAD_DIR, relPath), buffer);

    const created = await prisma.expense.create({
      data: {
        date,
        vendor: parsed.vendor,
        vendorVatId: parsed.vendorVatId ?? null,
        category: parsed.suggestedCategory,
        grossCents: parsed.totalGrossCents,
        netCents: parsed.netBaseCents,
        vatRate: parsed.vatRate,
        vatCents: parsed.vatCents,
        deductiblePct: pct,
        deductibleNetCents: ded.deductibleNetCents,
        deductibleVatCents: ded.deductibleVatCents,
        pdfPath: relPath,
        parsedJson: JSON.stringify(parsed),
        status: "PENDING_REVIEW",
        source: "UPLOAD",
        currency: parsed.currency || "EUR",
        notes: parsed.notes,
      },
    });

    await sendExpenseReview(token, chatId, created.id);
  } finally {
    stopTyping();
  }
}

// Render the PENDING_REVIEW expense card with inline buttons.
async function sendExpenseReview(
  token: string,
  chatId: number,
  expenseId: string,
  options?: { editMessageId?: number }
): Promise<void> {
  const e = await prisma.expense.findUnique({ where: { id: expenseId } });
  if (!e) return;
  const fmt = (c: number) => (c / 100).toFixed(2);
  const lines = [
    `📄 <b>${esc(e.vendor)}</b>`,
    `${esc(e.date.toISOString().slice(0, 10))}  ·  ${esc(prettyCat(e.category))}`,
    `Gross <b>€${fmt(e.grossCents)}</b>  (net €${fmt(e.netCents)} + VAT €${fmt(e.vatCents)})`,
    `Deductible <b>€${fmt(e.deductibleNetCents + e.deductibleVatCents)}</b>  (${e.deductiblePct}%)`,
    "",
    `<i>Status: ${e.status === "CONFIRMED" ? "✅ confirmed" : "pending review"}</i>`,
  ];
  const text = lines.join("\n");
  const reply_markup: tg.TelegramInlineKeyboard = {
    inline_keyboard: [
      [
        { text: e.status === "CONFIRMED" ? "✅ Confirmed" : "✅ Confirm", callback_data: `exp:confirm:${e.id}` },
        { text: "✏️ Category", callback_data: `exp:cat:${e.id}` },
      ],
      [
        { text: "🗑️ Delete", callback_data: `exp:del:${e.id}` },
        { text: "💬 Edit other", callback_data: `exp:agent:${e.id}` },
      ],
    ],
  };
  if (options?.editMessageId != null) {
    await tg.editMessageText(token, chatId, options.editMessageId, text, {
      parse_mode: "HTML",
      reply_markup,
    });
  } else {
    await tg.sendMessage(token, chatId, text, { parse_mode: "HTML", reply_markup });
  }
}

// Show inline category picker for an expense.
async function sendCategoryPicker(
  token: string,
  chatId: number,
  messageId: number,
  expenseId: string
): Promise<void> {
  const cats = EXPENSE_CATEGORIES;
  const rows: tg.TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < cats.length; i += 2) {
    rows.push(
      cats.slice(i, i + 2).map((c) => ({
        text: prettyCat(c),
        callback_data: `exp:setcat:${expenseId}:${c}`,
      }))
    );
  }
  rows.push([{ text: "↩️ Back", callback_data: `exp:show:${expenseId}` }]);
  await tg.editMessageText(
    token,
    chatId,
    messageId,
    `Pick a category for this expense:`,
    { reply_markup: { inline_keyboard: rows } }
  );
}

// ---- Callback query routing ----

async function handleCallback(
  token: string,
  allowed: Set<string>,
  cq: tg.TelegramCallbackQuery
): Promise<void> {
  const chatId = cq.message?.chat.id;
  const fromId = cq.from.id;
  if (chatId == null || (!allowed.has(String(fromId)) && !allowed.has(String(chatId)))) {
    await tg.answerCallbackQuery(token, cq.id, "Not authorized", true);
    return;
  }
  const data = cq.data ?? "";
  const messageId = cq.message?.message_id;
  const parts = data.split(":");
  const [domain, action] = parts;

  try {
    if (domain === "exp" && messageId != null) {
      const expenseId = parts[2];
      switch (action) {
        case "confirm": {
          await prisma.expense.update({
            where: { id: expenseId },
            data: { status: "CONFIRMED" },
          });
          await tg.answerCallbackQuery(token, cq.id, "✅ Confirmed");
          await sendExpenseReview(token, chatId, expenseId, { editMessageId: messageId });
          break;
        }
        case "cat": {
          await tg.answerCallbackQuery(token, cq.id);
          await sendCategoryPicker(token, chatId, messageId, expenseId);
          break;
        }
        case "setcat": {
          const newCat = parts[3] as ExpenseCategory;
          await applyCategoryChange(expenseId, newCat);
          await tg.answerCallbackQuery(token, cq.id, `→ ${prettyCat(newCat)}`);
          await sendExpenseReview(token, chatId, expenseId, { editMessageId: messageId });
          break;
        }
        case "show": {
          await tg.answerCallbackQuery(token, cq.id);
          await sendExpenseReview(token, chatId, expenseId, { editMessageId: messageId });
          break;
        }
        case "del": {
          await prisma.expense.delete({ where: { id: expenseId } });
          await tg.answerCallbackQuery(token, cq.id, "🗑️ Deleted");
          await tg.editMessageText(
            token,
            chatId,
            messageId,
            `🗑️ Expense deleted.`,
          );
          break;
        }
        case "agent": {
          // Hand off to the agent with a synthesised "the user wants to edit this" message.
          await tg.answerCallbackQuery(token, cq.id, "Tell me what to change");
          await tg.editMessageReplyMarkup(token, chatId, messageId, undefined);
          await tg.sendMessage(
            token,
            chatId,
            `What should I change about expense <code>${esc(expenseId)}</code>?\nExamples: "set vendor to Holaluz", "gross €123,45", "date 2025-10-31".`,
            { parse_mode: "HTML" }
          );
          break;
        }
        default:
          await tg.answerCallbackQuery(token, cq.id, "Unknown action");
      }
      return;
    }
    if (domain === "pending" && messageId != null) {
      await handlePendingCallback(token, chatId, messageId, cq.id, parts[1], parts[2]);
      return;
    }
    await tg.answerCallbackQuery(token, cq.id, "Unknown callback");
  } catch (err) {
    console.error(`[bot] callback error:`, err);
    await tg.answerCallbackQuery(
      token,
      cq.id,
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      true
    );
  }
}

// Pending action (mutation gate) — applies or cancels a queued update/delete.
async function handlePendingCallback(
  token: string,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  action: string,
  pendingId: string
): Promise<void> {
  if (action === "cancel") {
    const cancelled = consumePending(pendingId);
    await tg.answerCallbackQuery(token, callbackQueryId, "✕ Cancelled");
    const body = cancelled
      ? `${cancelled.summary}\n\n<b>✕ Cancelled</b> — no changes made.`
      : `<i>✕ Cancelled.</i>`;
    await tg.editMessageText(token, chatId, messageId, body, { parse_mode: "HTML" });
    return;
  }
  if (action !== "apply") {
    await tg.answerCallbackQuery(token, callbackQueryId, "Unknown action");
    return;
  }
  const pending = consumePending(pendingId);
  if (!pending) {
    await tg.answerCallbackQuery(
      token,
      callbackQueryId,
      "Confirmation expired (15-minute timeout) — ask the bot to propose it again.",
      true
    );
    return;
  }
  try {
    if (pending.type === "update_expense") {
      await executeUpdateExpense(pending.args as unknown as UpdateExpenseArgs);
      await tg.answerCallbackQuery(token, callbackQueryId, "✅ Applied");
      await tg.editMessageText(
        token,
        chatId,
        messageId,
        `${pending.summary}\n\n<b>✅ Applied</b>`,
        { parse_mode: "HTML" }
      );
    } else if (pending.type === "delete_expense") {
      await executeDeleteExpense(pending.args.id);
      await tg.answerCallbackQuery(token, callbackQueryId, "🗑️ Deleted");
      await tg.editMessageText(
        token,
        chatId,
        messageId,
        `${pending.summary}\n\n<b>🗑️ Deleted</b>`,
        { parse_mode: "HTML" }
      );
    } else if (pending.type === "update_invoice") {
      const result = await executeUpdateInvoice(pending.args as unknown as UpdateInvoiceAgentArgs);
      await tg.answerCallbackQuery(token, callbackQueryId, "✅ Applied");
      await tg.editMessageText(
        token,
        chatId,
        messageId,
        `${pending.summary}\n\n<b>✅ Applied</b> · ${esc(result.number)}`,
        { parse_mode: "HTML" }
      );
    } else if (pending.type === "delete_invoice") {
      await executeDeleteInvoice(pending.args.id);
      await tg.answerCallbackQuery(token, callbackQueryId, "🗑️ Deleted");
      await tg.editMessageText(
        token,
        chatId,
        messageId,
        `${pending.summary}\n\n<b>🗑️ Deleted</b>`,
        { parse_mode: "HTML" }
      );
    }
  } catch (err) {
    await tg.answerCallbackQuery(
      token,
      callbackQueryId,
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      true
    );
    await tg.editMessageText(
      token,
      chatId,
      messageId,
      `${pending.summary}\n\n<b>⚠️ Failed:</b> ${esc(err instanceof Error ? err.message : String(err))}`,
      { parse_mode: "HTML" }
    );
  }
}

async function applyCategoryChange(id: string, newCategory: ExpenseCategory): Promise<void> {
  const e = await prisma.expense.findUnique({ where: { id } });
  if (!e) return;
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) return;
  const pct = defaultDeductiblePct(newCategory, settings, e.date);
  const ded = applyDeduction(pct, e.netCents, e.vatCents);
  await prisma.expense.update({
    where: { id },
    data: {
      category: newCategory,
      deductiblePct: pct,
      deductibleNetCents: ded.deductibleNetCents,
      deductibleVatCents: ded.deductibleVatCents,
    },
  });
}

// ---- helpers ----

function safeDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function esc(s: string): string {
  return tg.escapeHtml(s);
}

function prettyCat(c: ExpenseCategory): string {
  return c.replace(/_/g, " ").toLowerCase();
}

main()
  .catch((err) => {
    console.error("[bot] fatal:", err);
    process.exit(1);
  });
