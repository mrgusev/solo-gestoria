type SearchParams = Promise<{ error?: string; next?: string }>;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { error, next } = await searchParams;
  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
      <form
        method="POST"
        action="/api/auth/login"
        className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-xl font-semibold tracking-tight">Solo Gestoría</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Sign in to continue
        </p>
        <input type="hidden" name="next" value={next ?? "/"} />
        <label className="mt-6 block">
          <span className="text-sm font-medium text-neutral-700">Password</span>
          <input
            type="password"
            name="password"
            required
            autoFocus
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
        </label>
        {error ? (
          <p className="mt-3 text-sm text-red-600">Incorrect password.</p>
        ) : null}
        <button
          type="submit"
          className="mt-6 w-full rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
