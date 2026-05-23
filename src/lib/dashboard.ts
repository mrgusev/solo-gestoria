// Server-only re-export of the dashboard data fetchers. Importing this
// module from a Client Component throws at build time. Plain Node scripts
// that need the same data (e.g. the Telegram bot worker) should import
// directly from `./dashboard-data`.
import "server-only";

export { monthlyTotals, activeYearsList } from "./dashboard-data";
