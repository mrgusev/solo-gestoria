"use client";

import { useState, type ReactNode } from "react";

// The auth-method picker plus whichever credential block it selects. This has
// to be a client component: the rest of the Settings page is server-rendered,
// so without local state the fields would only swap after a save — which reads
// as "the dropdown does nothing".
//
// Both blocks are built on the server and passed in as nodes, so the server
// actions bound to the buttons inside them keep working.
export default function SmtpAuthFields({
  initialMode,
  passwordFields,
  googleFields,
}: {
  initialMode: string;
  passwordFields: ReactNode;
  googleFields: ReactNode;
}) {
  const [mode, setMode] = useState(initialMode === "OAUTH2" ? "OAUTH2" : "PASSWORD");

  return (
    <>
      <label className="block">
        <span className="text-sm font-medium text-neutral-700">Authentication</span>
        <select
          name="smtpAuthType"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
        >
          <option value="PASSWORD">Password / Gmail App Password</option>
          <option value="OAUTH2">Sign in with Google (OAuth2)</option>
        </select>
      </label>
      {mode === "OAUTH2" ? googleFields : passwordFields}
    </>
  );
}
