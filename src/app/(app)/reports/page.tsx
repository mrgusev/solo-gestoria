import { redirect } from "next/navigation";
import { quarterOf } from "@/lib/tax";

export default function ReportsIndexPage() {
  const now = new Date();
  redirect(`/reports/${now.getUTCFullYear()}/${quarterOf(now)}`);
}
