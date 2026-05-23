// In-memory store for mutations the agent has *proposed* but not yet executed.
// Mutating tools (update_expense, delete_expense) cannot apply directly —
// they enqueue a pending action here and send a confirmation message with
// Apply / Cancel buttons. The bot-worker's callback handler is the only
// code path that resolves a pending action.
//
// In-memory is fine since the worker is a single process. If the worker
// restarts mid-confirmation, pending entries disappear — the user just gets
// "Confirmation expired" when they tap the button, which is the safe outcome.

import crypto from "node:crypto";

export type PendingAction =
  | {
      type: "update_expense";
      chatId: number;
      args: Record<string, unknown>;
      summary: string;
    }
  | {
      type: "delete_expense";
      chatId: number;
      args: { id: string };
      summary: string;
    }
  | {
      type: "update_invoice";
      chatId: number;
      args: Record<string, unknown>;
      summary: string;
    }
  | {
      type: "delete_invoice";
      chatId: number;
      args: { id: string };
      summary: string;
    };

type Entry = { action: PendingAction; createdAt: number };

const store = new Map<string, Entry>();
const TTL_MS = 15 * 60 * 1000;

function gc(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.createdAt > TTL_MS) store.delete(k);
  }
}

export function createPending(action: PendingAction): string {
  gc();
  const id = crypto.randomUUID().slice(0, 12);
  store.set(id, { action, createdAt: Date.now() });
  return id;
}

export function consumePending(id: string): PendingAction | null {
  gc();
  const v = store.get(id);
  if (!v) return null;
  store.delete(id);
  return v.action;
}

export function peekPending(id: string): PendingAction | null {
  gc();
  return store.get(id)?.action ?? null;
}
