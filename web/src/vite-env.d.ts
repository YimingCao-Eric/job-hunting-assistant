/// <reference types="vite/client" />

/**
 * NOTE: NEXT_PUBLIC_API_BASE is deliberately NOT declared. Vite only exposes
 * VITE_*-prefixed vars on import.meta.env, so the old app's fallback
 * (autoScrape.ts:15) was ALWAYS undefined regardless of .env -- dead code
 * left over from the Next.js graft. (research R19)
 *
 * Both vars are baked into the bundle at BUILD time, as built. The bearer
 * token therefore ships in the production bundle; unchanged from as-built,
 * and the spec's Assumptions preserve this.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_AUTH_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
