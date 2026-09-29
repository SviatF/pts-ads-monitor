const DEFAULT_REDIRECT_URI = "https://pts-ads-monitor.oleg22777.workers.dev/api/google/oauth/callback";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

let tokenCache: { token: string; expiresAt: number } | null = null;

export function getGoogleOAuthConfig() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "",
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI,
  };
}

export function buildGoogleOAuthUrl() {
  const cfg = getGoogleOAuthConfig();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("Google OAuth client is not configured.");
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string) {
  const cfg = getGoogleOAuthConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google OAuth exchange failed (${response.status}): ${text}`);
  return JSON.parse(text) as { access_token: string; expires_in: number; refresh_token?: string };
}

export async function getGoogleUserAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const cfg = getGoogleOAuthConfig();
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    throw new Error("Google user OAuth is not connected yet.");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google OAuth refresh failed (${response.status}): ${text}`);
  const body = JSON.parse(text) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

export function hasGoogleUserOAuth() {
  const cfg = getGoogleOAuthConfig();
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
}
