/**
 * One-shot Stripe sync. Run with `npm run stripe:sync`.
 * Same code path as the in-app timer and the Settings "Sync now" button.
 */
import "dotenv/config";
import { syncStripe, summarizeSync } from "../src/lib/stripe-sync";

syncStripe()
  .then((r) => {
    console.log(summarizeSync(r));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
