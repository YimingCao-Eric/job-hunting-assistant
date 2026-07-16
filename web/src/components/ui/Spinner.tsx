export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  /** Becomes aria-label; omit inside a Button, which is already labelled. */
  label?: string
}

const SIZE: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'h-3.5 w-3.5 border-2',
  md: 'h-5 w-5 border-2',
  lg: 'h-8 w-8 border-[3px]',
}

/**
 * Self-contained: the animation is Tailwind's `animate-spin`. The old Spinner
 * was entirely inline-styled AND depended on a @keyframes spin declared in a
 * global index.css -- a coupling this removes.
 */
export function Spinner({ size = 'md', label }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label ?? 'Loading'}
      className={[
        'inline-block shrink-0 animate-spin rounded-full',
        'border-current border-r-transparent align-[-0.125em]',
        SIZE[size],
      ].join(' ')}
    />
  )
}
