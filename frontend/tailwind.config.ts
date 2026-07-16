import type { Config } from 'tailwindcss'

/** Token -> CSS custom property, with Tailwind alpha support (`bg-surface-card/50`). */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],

  // NOTE: `preflight` is deliberately NOT disabled. The old config set
  // `corePlugins: { preflight: false }` solely to stop Tailwind's reset
  // colliding with 2,845 lines of CSS modules. Those are gone, so the
  // containment measure is obsolete and leaving it off would ship an
  // un-normalized baseline. (research R9)

  theme: {
    extend: {
      // The single token set (FR-007, SC-006). No page or feature component
      // may declare a color/radius/shadow value -- only components/ui/ may,
      // and only by referencing these.
      //
      // `spacing` and `fontSize` are deliberately NOT re-declared: Tailwind's
      // scales are already token sets, and redefining them would create a
      // SECOND one -- exactly what this feature exists to eliminate.
      colors: {
        surface: {
          page: token('surface-page'),
          card: token('surface-card'),
          raised: token('surface-raised'),
          overlay: token('surface-overlay'),
        },
        border: {
          DEFAULT: token('border-default'),
          strong: token('border-strong'),
        },
        text: {
          primary: token('text-primary'),
          secondary: token('text-secondary'),
          muted: token('text-muted'),
          inverse: token('text-inverse'),
        },
        accent: {
          DEFAULT: token('accent-default'),
          hover: token('accent-hover'),
          subtle: token('accent-subtle'),
        },
        success: {
          DEFAULT: token('success-default'),
          hover: token('success-hover'),
          subtle: token('success-subtle'),
          text: token('success-text'),
        },
        warning: {
          DEFAULT: token('warning-default'),
          hover: token('warning-hover'),
          subtle: token('warning-subtle'),
          text: token('warning-text'),
        },
        danger: {
          DEFAULT: token('danger-default'),
          hover: token('danger-hover'),
          subtle: token('danger-subtle'),
          text: token('danger-text'),
        },
        info: {
          DEFAULT: token('info-default'),
          hover: token('info-hover'),
          subtle: token('info-subtle'),
          text: token('info-text'),
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        overlay: 'var(--shadow-overlay)',
      },
    },
  },
  plugins: [],
} satisfies Config
