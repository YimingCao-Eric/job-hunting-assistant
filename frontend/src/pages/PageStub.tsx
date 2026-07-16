/**
 * TEMPORARY. Placeholder for the four real pages so the shell, nav, and routing
 * are testable before any story phase lands (T037). Each stub is replaced by its
 * story's page task: T058 (Jobs), T069 (Auto-Scrape), T075 (Config), T082 (Logs).
 *
 * This file is deleted once the last stub is replaced.
 */
export function PageStub({
  title,
  surface,
  task,
}: {
  title: string
  surface: string
  task: string
}) {
  return (
    <div className="py-8">
      <h1 className="text-xl font-semibold tracking-tight text-text-primary">{title}</h1>
      <p className="mt-2 text-sm text-text-secondary">
        Not built yet — replaced by <code className="font-medium">{task}</code>.
      </p>
      <p className="mt-1 text-sm text-text-muted">
        Backend surface: <code>{surface}</code>
      </p>
    </div>
  )
}
