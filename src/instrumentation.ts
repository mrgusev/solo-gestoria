// Runs once per server boot. Starts the periodic Stripe sync when a key is
// configured, so Stripe invoices + fees land in the books without anyone
// clicking anything. Interval: STRIPE_SYNC_INTERVAL_MIN (default 60).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.STRIPE_SECRET_KEY?.trim()) return;

  const { syncStripe, summarizeSync } = await import("./lib/stripe-sync");
  const minutes = Math.max(5, Number(process.env.STRIPE_SYNC_INTERVAL_MIN ?? 60) || 60);

  const tick = () =>
    syncStripe()
      .then((r) => console.log(`[stripe] ${summarizeSync(r)}`))
      .catch((err) => console.error("[stripe] sync failed:", err?.message ?? err));

  // Give the server a moment to finish booting before the first run.
  setTimeout(tick, 15_000).unref();
  setInterval(tick, minutes * 60_000).unref();
}
