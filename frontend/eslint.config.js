import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * T008 (a) -- FR-030. The three /extension/pending* routes are read-once
 * mailboxes: they are GETs that MUTATE AND COMMIT. A single call clears the
 * flag, steals the extension's queued command, and THE SCAN SILENTLY NEVER
 * RUNS -- no error, no log, nothing to debug. The endpoints look like reads.
 * The gate, not vigilance, is what prevents this.
 * Safe substitute: GET /extension/state, which does not consume.
 */
const FORBIDDEN_ROUTE_MESSAGE =
  'FR-030: /extension/pending, /extension/pending-scan and /extension/pending-stop are read-once mailboxes. ' +
  'A GET clears the flag and steals the extension\'s queued command -- the scan then silently never runs. ' +
  'Use GET /extension/state instead (it does not consume). See contracts/backend-bindings.md "FORBIDDEN ROUTES".'

const forbiddenRouteRules = [
  { selector: 'Literal[value=/\\/extension\\/pending/]', message: FORBIDDEN_ROUTE_MESSAGE },
  { selector: 'TemplateElement[value.raw=/\\/extension\\/pending/]', message: FORBIDDEN_ROUTE_MESSAGE },
]

/**
 * T008 (b) -- FR-010. One shared access layer. The old app had src/api.js
 * (504 lines, untyped, several methods never checked response.ok), a second
 * typed layer in lib/api/autoScrape.ts, AND a third ad-hoc env read in
 * JobsPage.jsx for the WebSocket. lib/api/client.ts is the only fetch site.
 */
const FETCH_BAN_MESSAGE =
  'FR-010: fetch() is only permitted in src/lib/api/client.ts, the single shared access layer. ' +
  'Add an endpoint module under src/lib/api/ instead of calling fetch directly.'

const fetchBanRules = [
  { selector: "CallExpression[callee.name='fetch']", message: FETCH_BAN_MESSAGE },
  {
    selector: "MemberExpression[object.name='window'][property.name='fetch']",
    message: FETCH_BAN_MESSAGE,
  },
]

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },

  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-syntax': ['error', ...forbiddenRouteRules, ...fetchBanRules],
    },
  },

  {
    // The ONE exception to the fetch ban. The forbidden-route ban still applies
    // here -- client.ts is exactly where a pending* call would be most tempting.
    files: ['src/lib/api/client.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...forbiddenRouteRules],
    },
  },

  {
    // Config files run in Node, not the browser.
    files: ['*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
  },
)
