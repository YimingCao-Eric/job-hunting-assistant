/**
 * THE single app-wide "not authorized" state (T039).
 *
 * The spec's edge case: "the shell shows a single, consistent 'not authorized'
 * state explaining the configured credential was rejected, rather than each
 * page rendering its own empty or error variant." So this is rendered ONCE by
 * App.tsx and never by a page.
 *
 * No retry: unlike a network failure, a rejected credential will not fix itself
 * on a retry -- the token is baked in at BUILD time, so the operator must change
 * VITE_AUTH_TOKEN and restart. Offering a retry button here would be a lie.
 */
export function UnauthorizedState() {
  return (
    <div className="mx-auto max-w-xl py-16" role="alert">
      <p className="text-sm font-medium text-danger-text">Not authorized</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary">
        The backend rejected the configured credential
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-text-secondary">
        Every request returned <code className="text-xs">401 Unauthorized</code>. The bearer token
        this app was built with does not match what the backend expects.
      </p>
      <div className="mt-6 rounded-md border border-border bg-surface-card p-4 text-sm">
        <p className="font-medium text-text-primary">To fix it</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-text-secondary">
          <li>
            Set <code className="text-xs">VITE_AUTH_TOKEN</code> in <code className="text-xs">.env</code>{' '}
            to the value the backend accepts.
          </li>
          <li>
            Restart the dev server — the token is baked in at <strong>build</strong> time, so a page
            reload alone will not pick it up.
          </li>
        </ol>
      </div>
    </div>
  )
}
