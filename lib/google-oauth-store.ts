type GoogleOAuthRow = {
  id: string;
  refresh_token: string;
  connected_at: string;
  last_refresh_at: string | null;
  last_error: string | null;
  updated_at: string;
};

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase Google OAuth store failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function getStoredGoogleRefreshToken() {
  const rows = await request<GoogleOAuthRow[]>(
    "google_oauth_credentials?select=*&id=eq.primary&limit=1",
  );
  return rows[0]?.refresh_token || null;
}

export async function saveGoogleRefreshToken(refreshToken: string) {
  const now = new Date().toISOString();
  const rows = await request<GoogleOAuthRow[]>(
    "google_oauth_credentials?on_conflict=id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        id: "primary",
        refresh_token: refreshToken,
        connected_at: now,
        last_refresh_at: null,
        last_error: null,
        updated_at: now,
      }),
    },
  );
  return rows[0] || null;
}

export async function markGoogleOAuthRefreshSuccess() {
  const now = new Date().toISOString();
  await request("google_oauth_credentials?id=eq.primary", {
    method: "PATCH",
    body: JSON.stringify({
      last_refresh_at: now,
      last_error: null,
      updated_at: now,
    }),
  });
}

export async function markGoogleOAuthRefreshError(message: string) {
  await request("google_oauth_credentials?id=eq.primary", {
    method: "PATCH",
    body: JSON.stringify({
      last_error: message.slice(0, 1500),
      updated_at: new Date().toISOString(),
    }),
  });
}


export async function getGoogleOAuthStatus() {
  const rows = await request<Array<Pick<GoogleOAuthRow, "connected_at" | "last_refresh_at" | "last_error" | "updated_at">>>(
    "google_oauth_credentials?select=connected_at,last_refresh_at,last_error,updated_at&id=eq.primary&limit=1",
  );
  return rows[0] || null;
}
