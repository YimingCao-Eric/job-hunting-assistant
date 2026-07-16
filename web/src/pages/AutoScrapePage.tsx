import { ConfigEditor } from '@/components/auto-scrape/ConfigEditor'
import { CurrentCycle } from '@/components/auto-scrape/CurrentCycle'
import { CycleHistory } from '@/components/auto-scrape/CycleHistory'
import { SessionHealth } from '@/components/auto-scrape/SessionHealth'
import { StatusHeader } from '@/components/auto-scrape/StatusHeader'
import { Card } from '@/components/ui/Card'
import { PageTitle } from '@/components/ui/PageTitle'
import { ErrorState } from '@/components/ui/states/ErrorState'
import { LoadingState } from '@/components/ui/states/LoadingState'
import { useAutoScrape } from '@/hooks/useAutoScrape'

/**
 * Binds /admin/auto-scrape/* and nothing else.
 *
 * POLL-ONLY (FR-047): no push channel reaches this page -- the WS broadcast
 * fires only from PUT /extension/run-log/{id}. Reaper- and extension-driven
 * changes arrive on the 5s refetch interval.
 */
export function AutoScrapePage() {
  const { state, cycles, sessions, config, limits, instances, isPageLevelError, pageLevelError, retryAll, mutations } =
    useAutoScrape()

  // THE COMPOSITION RULE, first branch: all five queries failed with a network
  // error -> the backend is unreachable. ONE fact, ONE statement -- not five
  // stacked "could not reach the backend" cards.
  if (isPageLevelError && pageLevelError) {
    return (
      <>
        <PageTitle title="Auto-Scrape" />
        <ErrorState error={pageLevelError} variant="page" onRetry={retryAll} />
      </>
    )
  }

  return (
    <>
      <PageTitle title="Auto-Scrape" />

      <div className="flex flex-col gap-4 pb-10">
        {/* Second branch: from here down every section owns its OWN error. A
            failed `cycles` fetch must not blank a healthy `state` -- that is
            precisely the old page's bug (page.tsx:59-65). */}

        {state.isPending ? (
          <LoadingState label="Loading orchestrator status…" />
        ) : state.isError ? (
          <ErrorState error={state.error} onRetry={() => void state.refetch()} />
        ) : (
          <StatusHeader
            state={state.data}
            instances={instances.data}
            instancesError={instances.isError}
            mutations={mutations}
          />
        )}

        {state.data && cycles.data ? <CurrentCycle state={state.data.state} cycles={cycles.data} /> : null}

        {cycles.isPending ? (
          <Card title="Recent cycles">
            <LoadingState label="Loading cycles…" />
          </Card>
        ) : cycles.isError ? (
          <Card title="Recent cycles">
            <ErrorState error={cycles.error} onRetry={() => void cycles.refetch()} />
          </Card>
        ) : (
          <CycleHistory cycles={cycles.data} />
        )}

        {sessions.isPending ? (
          <Card title="Session health">
            <LoadingState label="Loading sessions…" />
          </Card>
        ) : sessions.isError ? (
          <Card title="Session health">
            <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
          </Card>
        ) : (
          <SessionHealth sessions={sessions.data} mutations={mutations} />
        )}

        {config.isPending || limits.isPending ? (
          <Card title="Orchestrator settings">
            <LoadingState label="Loading settings…" />
          </Card>
        ) : config.isError ? (
          <Card title="Orchestrator settings">
            <ErrorState error={config.error} onRetry={() => void config.refetch()} />
          </Card>
        ) : limits.isError ? (
          <Card title="Orchestrator settings">
            {/* Without the published limits we cannot validate against the
                server, and inventing bounds client-side is the exact stack-
                boundary violation this rewrite removes. So: no form. */}
            <ErrorState error={limits.error} onRetry={() => void limits.refetch()} />
          </Card>
        ) : (
          // `key` on the server's updated_at re-seeds the draft after a save or
          // reset by remounting -- no effect, no cascading render, and no risk
          // of clobbering unsaved edits on an unrelated refetch.
          <ConfigEditor
            key={config.data.updated_at}
            config={config.data.config}
            limits={limits.data}
            mutations={mutations}
          />
        )}
      </div>
    </>
  )
}
