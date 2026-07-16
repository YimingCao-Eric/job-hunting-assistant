import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  width?: string
  align?: 'left' | 'right'
}

export interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  /** Rendered in place of the body when `rows` is empty. */
  emptyState?: ReactNode
}

/**
 * FR-006 / SC-012 (360px, no horizontal scrolling) IS THIS COMPONENT'S JOB.
 * Every table in the app goes through it, so the narrow-viewport strategy is
 * implemented once: the table scrolls WITHIN its own `overflow-x-auto`
 * container and the PAGE BODY never scrolls horizontally. Per-page table markup
 * would mean solving this four times and getting it right maybe twice.
 */
export function Table<T>({ columns, rows, rowKey, onRowClick, emptyState }: TableProps<T>) {
  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>
  }

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border bg-surface-card">
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-raised">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                style={col.width ? { width: col.width } : undefined}
                className={[
                  'whitespace-nowrap px-3 py-2 text-xs font-semibold text-text-secondary',
                  col.align === 'right' ? 'text-right' : 'text-left',
                ].join(' ')}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={[
                'border-b border-border last:border-b-0',
                onRowClick ? 'cursor-pointer hover:bg-surface-raised' : '',
              ].join(' ')}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={[
                    'px-3 py-2 align-top text-text-primary',
                    col.align === 'right' ? 'text-right' : 'text-left',
                  ].join(' ')}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
