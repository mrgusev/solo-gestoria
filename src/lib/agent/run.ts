import OpenAI from "openai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../db";
import { executeTool, listToolsForOpenAI, type ToolContext } from "./tools";

const MODEL = "gpt-5.4";
const REASONING_EFFORT: "low" | "medium" | "high" = "medium";

// 30 minutes of idle resets the conversation context.
const CONVO_TTL_MS = 30 * 60 * 1000;

// Optional extra context for the agent prompt — loaded from
// prisma/seed.config.json ("agent" block). Lets the operator describe their
// own situation (intra-EU vs domestic, régimen, etc.) without editing TS.
type AgentConfig = { userDescription?: string; businessNotes?: string };
let _agentConfigCache: AgentConfig | undefined;
async function loadAgentConfig(): Promise<AgentConfig> {
  if (_agentConfigCache !== undefined) return _agentConfigCache;
  const candidates = [
    path.join(process.cwd(), "prisma/seed.config.json"),
    path.join(process.cwd(), "prisma/seed.config.example.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const json = JSON.parse(raw) as { agent?: AgentConfig };
      _agentConfigCache = json.agent ?? {};
      return _agentConfigCache;
    } catch {
      /* try next */
    }
  }
  _agentConfigCache = {};
  return _agentConfigCache;
}

async function buildSystemPrompt(): Promise<string> {
  const [settings, agentCfg] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 } }),
    loadAgentConfig(),
  ]);
  if (!settings) throw new Error("Settings missing — run db:seed");
  const defaultClient = settings.defaultClientId
    ? await prisma.client.findUnique({ where: { id: settings.defaultClientId } })
    : null;

  const userDesc = agentCfg.userDescription ?? "a self-employed software developer";
  const clientLine = defaultClient
    ? `He bills ${defaultClient.name} (${defaultClient.country}${defaultClient.vatId ? `, VAT ${defaultClient.vatId}` : ""}).`
    : "";
  const businessNotes = agentCfg.businessNotes ?? "";

  return `You are Solo Gestoría, a personal bookkeeping assistant for a Spanish autónomo (${userDesc}). The user is ${settings.issuerName} (NIF ${settings.issuerTaxId}, VAT ${settings.issuerVatId}), based in ${settings.issuerCity}. ${clientLine} ${businessNotes} Quarterly filings he cares about: MOD 130 (IRPF pago fraccionado), MOD 303 (IVA), MOD 349 (intra-EU recap).

${STATIC_GUIDANCE}`;
}

const STATIC_GUIDANCE = `Tax shortcuts you should know:
- MOD 130 box 04 (IRPF prepay) = 20% × (YTD income − YTD deductible). Box 07 = box 04 − sum of prior quarters' box 07.
- Home-office utilities (electricity, internet, water, gas) deduct at 30% × the area% he declared on modelo 036.
- Rent (RENT_HOUSING) deducts at the area% directly (no 30% multiplier), but only on/after the homeOfficeStartDate.
- RETA + gestoría + software + bank fees deduct at 100%.
- Intra-EU service invoices have 0% IVA, so MOD 303 always shows him "a compensar" the input VAT he paid.

How to behave:
- Be terse. Spanish accounting answers in 1-3 sentences when possible.
- Always format euros in es-ES style: € prefix, dot thousands, comma decimals — e.g. €4.140,00. The tools return cents; divide by 100 yourself.
- Dates: ISO YYYY-MM-DD when calling tools, but DD/MM/YYYY when displaying to the user.
- When the user references "this quarter" / "this month" / "this year", call get_current_date first.
- When the user asks for an invoice in natural language ("invoice November 69 hours"), interpret reasonably and call create_invoice. Confirm the resulting invoice number after creating. If the user wants the PDF, call send_invoice_pdf.
- PDF uploads are handled OUTSIDE your control: the worker parses the PDF, creates a PENDING_REVIEW expense, and shows the user inline buttons (Confirm / Category / Delete / Edit other). You only see uploaded PDF messages if the user taps "Edit other" or sends a follow-up text. Don't pre-emptively call update_expense after every upload.

Mutation gate — VERY IMPORTANT — read carefully:
- update_expense, delete_expense, update_invoice, delete_invoice are PROPOSAL tools, not mutation tools. They DO NOT change anything in the database. They send a confirmation card to the user's chat and return {pending: true, pendingId: "..."}.

Invoice lock rule:
- Invoices auto-lock at the MOD 303 filing deadline of their quarter (Q1→Apr 21, Q2→Jul 21, Q3→Oct 21, Q4→Jan 31 next year). Locked invoices return {pending: false, error: "invoice_locked"} when update/delete is called.
- If you get that error, do NOT retry. Tell the user that legally they need to issue a factura rectificativa (a corrective invoice with negative line items) rather than amending the original. We don't currently have a tool for that — explain that this is intentional and tracks Spanish invoicing law (Real Decreto 1619/2012).
- For invoices in the CURRENT (not-yet-filed) quarter, update/delete work normally via the confirmation gate.

- The mutation is APPLIED only when the user physically taps the green "✅ Apply" button on the card. The button-tap is processed by a separate code path (not by you).
- If you call update_expense and see {pending: true} in the result, that means: "card sent, waiting for the user." It does NOT mean "applied."
- NEVER write "Done", "updated", "applied", "changed", or any past-tense success language after calling update_expense / delete_expense. Use future tense: "I've proposed the change — tap Apply on the card above."
- If the user asks for N changes at once, call update_expense once per change. Each gets its own confirmation card. After the calls, end with one sentence: "I've queued N updates — tap Apply on each card to commit them."
- Don't call get_expense afterwards to "verify" — the card the tool sent already shows the diff.
- The user may Cancel any card. You won't be informed; assume nothing.

- Never invent IDs or numbers — only use values returned by tools.
- If the user asks something that can't be answered from the tools, say so plainly.

Telegram HTML formatting (messages are sent with parse_mode=HTML):
- Use <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, <code>fixed-width</code>, <pre>code block</pre>, <a href="https://...">link</a>.
- DO NOT use Markdown syntax — no *bold*, no **bold**, no _italic_, no \`code\`. Those will appear as literal characters.
- The ONLY characters you must escape in plain text are: & → &amp;  <  → &lt;  >  → &gt;
- Periods, commas, parens, dashes, hyphens, brackets, # + - = | { } . ! all stay as-is. No backslash escaping needed for them.
- Newlines are real \\n — they render as line breaks. No special tag needed.
- Examples (these are exactly what your output should look like):
    €4.140,00 (Q3) → no escaping needed
    FACT-2025-00007 → no escaping needed
    <b>Q4 2025</b>: income €8.460,00, deductible €1.842,26
    Box <code>07</code>: <b>€1.224,77</b>
- Use formatting sparingly. Bold the key number(s) the user asked about; leave everything else plain.
- The runtime will retry as plain text if your HTML is malformed, so the message will still arrive, just unformatted — but try to get it right.`;

export type AgentResult = {
  text: string;
  toolCallCount: number;
};

export async function runAgentTurn(args: {
  chatId: number;
  telegramToken: string;
  userMessage: string;
}): Promise<AgentResult> {
  const client = new OpenAI();
  const tools = listToolsForOpenAI();
  const ctx: ToolContext = { chatId: args.chatId, telegramToken: args.telegramToken };

  // Resolve / refresh the conversation context.
  const chatKey = String(args.chatId);
  let convo = await prisma.agentConversation.findUnique({ where: { chatId: chatKey } });
  let previousResponseId: string | null = null;
  if (convo) {
    const stale = Date.now() - convo.lastActivityAt.getTime() > CONVO_TTL_MS;
    previousResponseId = stale ? null : convo.lastResponseId;
  } else {
    convo = await prisma.agentConversation.create({ data: { chatId: chatKey } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resp: any = await client.responses.create({
    model: MODEL,
    reasoning: { effort: REASONING_EFFORT },
    tools,
    // Re-send the full system prompt every turn. With `previous_response_id`,
    // OpenAI documents this as overriding the prior instructions, which we
    // want because models tend to drift back to Markdown defaults otherwise.
    instructions: await buildSystemPrompt(),
    input: [{ role: "user", content: args.userMessage }],
    previous_response_id: previousResponseId ?? undefined,
  });

  let toolCallCount = 0;
  const MAX_LOOPS = 10;

  for (let i = 0; i < MAX_LOOPS; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: any[] = (resp.output ?? []).filter((o: any) => o.type === "function_call");
    if (calls.length === 0) break;

    const followups = [] as Array<{
      type: "function_call_output";
      call_id: string;
      output: string;
    }>;
    for (const call of calls) {
      toolCallCount++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.arguments ?? "{}");
      } catch {
        parsed = {};
      }
      const result = await executeTool(call.name, parsed, ctx);
      followups.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }

    // Continue the run with the tool outputs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resp = await client.responses.create({
      model: MODEL,
      reasoning: { effort: REASONING_EFFORT },
      tools,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input: followups as any,
      previous_response_id: resp.id,
    });
  }

  const text = extractFinalText(resp);
  await prisma.agentConversation.update({
    where: { chatId: chatKey },
    data: { lastResponseId: resp.id, lastActivityAt: new Date() },
  });

  return { text, toolCallCount };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFinalText(resp: any): string {
  // Responses API: look in `output_text` convenience field first, then assemble
  // from `message` items.
  if (typeof resp.output_text === "string" && resp.output_text.length > 0) {
    return resp.output_text;
  }
  const parts: string[] = [];
  for (const item of resp.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim() || "(no response)";
}

export async function resetConversation(chatId: number | string): Promise<void> {
  await prisma.agentConversation.update({
    where: { chatId: String(chatId) },
    data: { lastResponseId: null, lastActivityAt: new Date() },
  });
}
