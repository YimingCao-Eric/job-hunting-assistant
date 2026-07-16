import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { buildSearchPreview } from '@/lib/format/searchPreview'
import type { SearchConfig } from '@/types/config'

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={!value}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function PreviewRow({ site, url, note }: { site: string; url: string; note?: string | null }) {
  return (
    <div className="space-y-1.5 border-b border-border py-3 last:border-b-0 last:pb-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-text-primary">{site}</span>
        <div className="flex items-center gap-2">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-accent hover:underline"
            >
              Open ↗
            </a>
          ) : null}
          <CopyButton value={url} />
        </div>
      </div>
      {url ? (
        <code className="block break-all rounded-sm bg-surface-raised px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary">
          {url}
        </code>
      ) : (
        <p className="text-xs text-text-muted">
          Cannot build a URL — the Glassdoor keyword/location slugs are missing.
        </p>
      )}
      {note ? <p className="text-[11px] leading-relaxed text-text-muted">{note}</p> : null}
    </div>
  )
}

export interface SearchPreviewProps {
  /** The DRAFT, not the saved config -- FR-019 requires unsaved state. */
  draft: SearchConfig
}

/**
 * FR-019: a live preview of the search each site will perform, reflecting the
 * CURRENT UNSAVED FORM STATE, with the ability to copy it.
 *
 * Mirrors extension/background/search_urls.js, the authority on what actually
 * gets navigated. See lib/format/searchPreview.ts for the three ways the old
 * frontend's preview diverged from it.
 */
export function SearchPreview({ draft }: SearchPreviewProps) {
  const preview = buildSearchPreview(draft)

  return (
    <Card title="Search preview">
      <p className="pb-3 text-xs text-text-muted">
        What each site will be asked for, using the values currently in the form — including unsaved
        edits.
      </p>
      <PreviewRow site="LinkedIn" url={preview.linkedin} note={preview.linkedinNote} />
      <PreviewRow site="Indeed" url={preview.indeed} />
      <PreviewRow site="Glassdoor" url={preview.glassdoor} />
    </Card>
  )
}
