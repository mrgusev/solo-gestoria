"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function ExpenseUploader() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function upload(files: FileList) {
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/expenses/upload", { method: "POST", body: fd });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Upload failed (${res.status})`);
        }
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center rounded-md border-2 border-dashed p-8 text-sm transition-colors cursor-pointer ${
          dragging
            ? "border-black bg-neutral-50"
            : "border-neutral-300 hover:border-neutral-400 bg-white"
        }`}
      >
        <input
          type="file"
          accept="application/pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) void upload(e.target.files);
          }}
          disabled={busy}
        />
        <div className="text-neutral-700">
          {busy ? "Parsing with OpenAI..." : "Drop PDFs here or click to select"}
        </div>
        <div className="mt-1 text-xs text-neutral-500">
          We extract vendor, date, amounts, and suggest a category. You review before saving.
        </div>
      </label>
      {error ? (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          {error}
        </div>
      ) : null}
    </div>
  );
}
