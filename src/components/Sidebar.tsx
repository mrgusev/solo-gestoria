"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

const items = [
  { href: "/", label: "Dashboard" },
  { href: "/invoices", label: "Invoices" },
  { href: "/expenses", label: "Expenses" },
  { href: "/reports", label: "Reports" },
  { href: "/settings", label: "Settings" },
];

function isActive(path: string, href: string): boolean {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}

export default function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(path);
  // React-recommended "reset state when a prop changes" pattern: compare in
  // render and call the setter directly so the drawer closes on navigation
  // without an effect.
  if (lastPath !== path) {
    setLastPath(path);
    setOpen(false);
  }

  // Lock background scroll + close on Escape while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {/* Mobile top bar — sticky so it stays visible while scrolling. */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between border-b border-neutral-200 bg-neutral-50/95 backdrop-blur px-4 h-12">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          Solo Gestoría
        </Link>
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="-mr-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-200"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M3 5h14M3 10h14M3 15h14"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      {/* Mobile drawer overlay. md:hidden on the wrapper so it can never appear on desktop. */}
      {open ? (
        <div className="md:hidden fixed inset-0 z-40">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 w-64 max-w-[80%] bg-neutral-50 border-r border-neutral-200 flex flex-col shadow-xl"
          >
            <div className="px-5 py-5 border-b border-neutral-200 flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold tracking-tight">Solo Gestoría</div>
                <div className="text-xs text-neutral-500">Autónomo bookkeeping</div>
              </div>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="-mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path
                    d="M4 4l10 10M14 4L4 14"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <NavList path={path} />
            <SignOut />
          </aside>
        </div>
      ) : null}

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 shrink-0 border-r border-neutral-200 bg-neutral-50 flex-col">
        <div className="px-5 py-5 border-b border-neutral-200">
          <div className="text-sm font-semibold tracking-tight">Solo Gestoría</div>
          <div className="text-xs text-neutral-500">Autónomo bookkeeping</div>
        </div>
        <NavList path={path} />
        <SignOut />
      </aside>
    </>
  );
}

function NavList({ path }: { path: string }) {
  return (
    <nav className="flex-1 px-2 py-3 space-y-0.5">
      {items.map((it) => {
        const active = isActive(path, it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={cn(
              "block rounded-md px-3 py-1.5 text-sm",
              active
                ? "bg-accent-500 text-white"
                : "text-neutral-700 hover:bg-neutral-200"
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

function SignOut() {
  return (
    <form method="POST" action="/api/auth/logout" className="p-3">
      <button
        type="submit"
        className="w-full text-left rounded-md px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-200"
      >
        Sign out
      </button>
    </form>
  );
}
