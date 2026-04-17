/**
 * OAuth2 access-token refresh middleware. Keeps a fresh bearer token
 * in memory and exposes it via `msg.headers.authorization` so drivers
 * (SMTP XOAUTH2, Gmail REST, Microsoft Graph) see a valid token every
 * send.
 *
 * Ships Gmail + Microsoft 365 presets; other IdPs are one line of
 * config.
 *
 * @module
 */

import type { Middleware } from "../types.ts"

export interface OAuth2TokenCache {
  get: () => { accessToken: string; expiresAt: number } | null
  set: (accessToken: string, expiresAt: number) => void
}

export interface OAuth2Options {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  refreshToken: string
  /** Extra form fields (e.g. `scope`). */
  extraParams?: Record<string, string>
  /** Seconds to subtract from `expires_in` so we refresh before expiry.
   *  Default: 30s. */
  skewSeconds?: number
  /** Injected for tests. */
  now?: () => number
  fetch?: typeof fetch
  cache?: OAuth2TokenCache
}

export interface OAuth2TokenResponse {
  access_token: string
  expires_in: number
  token_type?: string
}

/** Generic OAuth2 refresh-token → access-token middleware. */
export function withOAuth2(options: OAuth2Options): Middleware {
  const cache = options.cache ?? memoryCache()
  const skew = (options.skewSeconds ?? 30) * 1000
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch
  return {
    name: "oauth2",
    async beforeSend(msg) {
      const token = await ensureToken()
      const headers: Record<string, string> = { ...(msg.headers ?? {}) }
      headers.authorization = `Bearer ${token}`
      ;(msg as { headers?: Record<string, string> }).headers = headers
    },
  }

  async function ensureToken(): Promise<string> {
    const cached = cache.get()
    if (cached && now() < cached.expiresAt - skew) return cached.accessToken
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
      ...options.extraParams,
    })
    const res = await fetchImpl(options.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    if (!res.ok) {
      throw new Error(`[unemail/oauth2] refresh failed: ${res.status} ${await res.text()}`)
    }
    const payload = (await res.json()) as OAuth2TokenResponse
    cache.set(payload.access_token, now() + payload.expires_in * 1000)
    return payload.access_token
  }
}

/** Gmail OAuth2 preset. Pass `{ clientId, clientSecret, refreshToken }`. */
export function oauth2Gmail(
  config: Omit<OAuth2Options, "tokenEndpoint" | "extraParams"> & {
    extraParams?: Record<string, string>
  },
): Middleware {
  return withOAuth2({
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    extraParams: { scope: "https://mail.google.com/" },
    ...config,
  })
}

/** Microsoft 365 / Outlook.com OAuth2 preset. */
export function oauth2Microsoft(
  config: Omit<OAuth2Options, "tokenEndpoint" | "extraParams"> & {
    tenantId?: string
    extraParams?: Record<string, string>
  },
): Middleware {
  const { tenantId = "common", ...rest } = config
  return withOAuth2({
    tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    extraParams: { scope: "https://outlook.office.com/.default" },
    ...rest,
  })
}

function memoryCache(): OAuth2TokenCache {
  let cached: { accessToken: string; expiresAt: number } | null = null
  return {
    get: () => cached,
    set: (accessToken, expiresAt) => {
      cached = { accessToken, expiresAt }
    },
  }
}
