import { useMemo, useState } from 'react'

import { ConfigForm } from '@/components/config/ConfigForm'
import { SearchPreview } from '@/components/config/SearchPreview'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PageTitle } from '@/components/ui/PageTitle'
import { ErrorState } from '@/components/ui/states/ErrorState'
import { LoadingState } from '@/components/ui/states/LoadingState'
import { useConfig } from '@/hooks/useConfig'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import type { SearchConfig, SearchConfigUpdate } from '@/types/config'

/** Inner component: mounted only once the server config exists, and KEYED on it,
 *  so the draft re-seeds by remount after a save rather than via an effect. */
function ConfigEditor({ saved }: { saved: SearchConfig }) {
  const { save } = useConfig()
  const [draft, setDraft] = useState<SearchConfig>(saved)

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved])

  // FR-020: warn before navigation that would discard edits. useBlocker only
  // works under a data router -- which is why router.tsx uses createBrowserRouter.
  const guard = useUnsavedGuard(isDirty)

  // FR-021: on a rejected save the field-specific reason shows AND the draft is
  // retained untouched. `draft` is never reset here on error.
  const fieldErrors = save.isError ? (save.error.fieldErrors ?? {}) : {}

  const onSave = () => {
    // Send only what the form owns. The four dead fields are absent from
    // SearchConfig entirely, so this body cannot contain them -- and NOT
    // SENDING is what preserves them across the exclude_unset merge (FR-018).
    const body: SearchConfigUpdate = { ...draft }
    save.mutate(body)
  }

  return (
    <>
      <PageTitle
        title="Config"
        actions={
          <div className="flex items-center gap-2">
            {/* FR-020: indicate unsaved changes. */}
            {isDirty ? <Badge tone="info">Unsaved changes</Badge> : null}
            <Button variant="secondary" onClick={() => setDraft(saved)} disabled={!isDirty || save.isPending}>
              Discard
            </Button>
            <Button variant="primary" busy={save.isPending} disabled={!isDirty} onClick={onSave}>
              Save
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-4 pb-10">
        {/* FR-020: confirm a successful save. */}
        {save.isSuccess && !isDirty ? (
          <p className="rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success-text">
            Settings saved.
          </p>
        ) : null}

        {/* FR-021 / FR-016: the SPECIFIC rejection reason, not a generic failure.
            /config returns SHAPE 1 -- {"detail": "<plain string>"} -- which a
            naive FastAPI-array handler would break on. normalizeError sorts it
            out, so error.message is the backend's own words. */}
        {save.isError ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger-text"
          >
            <p className="font-medium">Could not save your changes.</p>
            <p className="mt-0.5">{save.error.message}</p>
            <p className="mt-1 text-xs text-text-secondary">
              Your edits are still here — nothing was saved, and nothing was partially applied.
            </p>
          </div>
        ) : null}

        <SearchPreview draft={draft} />

        <ConfigForm draft={draft} onChange={setDraft} fieldErrors={fieldErrors} />
      </div>

      <ConfirmDialog {...guard.dialogProps} />
    </>
  )
}

export function ConfigPage() {
  const { config } = useConfig()

  if (config.isPending) {
    return (
      <>
        <PageTitle title="Config" />
        <LoadingState label="Loading settings…" />
      </>
    )
  }

  // The spec's "Config storage is malformed" edge case: a malformed config.json
  // yields 500 {"detail": "config.json is malformed: ..."}. We report that the
  // settings could not be READ and render NO FORM -- an empty form would
  // overwrite the file on save, destroying the very data we failed to parse.
  if (config.isError) {
    return (
      <>
        <PageTitle title="Config" />
        <ErrorState error={config.error} variant="page" onRetry={() => void config.refetch()} />
        <p className="mx-auto mt-3 max-w-lg text-center text-xs text-text-muted">
          No form is shown while settings cannot be read — saving an empty form would overwrite the
          stored configuration.
        </p>
      </>
    )
  }

  // Key on the server's own values so a save re-seeds the draft by remounting.
  return <ConfigEditor key={JSON.stringify(config.data)} saved={config.data} />
}
