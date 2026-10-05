type ProjectLifecycleRow = {
  meta_account_id: string;
  status: "active" | "ended";
  ended_at: string | null;
  ended_by: string | null;
  created_at: string;
  updated_at: string;
};

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (!response.ok) throw new Error(`Supabase project lifecycle request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function listEndedProjects() {
  const rows = await request<ProjectLifecycleRow[]>("project_lifecycle?select=*&status=eq.ended");
  return rows;
}

export async function getProjectLifecycle(metaAccountId: string) {
  const rows = await request<ProjectLifecycleRow[]>(
    `project_lifecycle?select=*&meta_account_id=eq.${encodeURIComponent(metaAccountId)}&limit=1`
  );
  return rows[0] || null;
}

export async function isProjectEnded(metaAccountId: string) {
  return (await getProjectLifecycle(metaAccountId))?.status === "ended";
}

export async function endProjectCooperation(metaAccountId: string, endedBy = "dashboard") {
  const now = new Date().toISOString();

  await request<ProjectLifecycleRow[]>("project_lifecycle?on_conflict=meta_account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      meta_account_id: metaAccountId,
      status: "ended",
      ended_at: now,
      ended_by: endedBy,
      updated_at: now,
    }),
  });

  await Promise.all([
    request(
      `performance_monitoring_configs?meta_account_id=eq.${encodeURIComponent(metaAccountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: false, updated_at: now }),
      },
    ),
    request(
      `reporting_configs?meta_account_id=eq.${encodeURIComponent(metaAccountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "ended",
          performance_monitoring_enabled: false,
          updated_at: now,
        }),
      },
    ),
    request(
      `performance_alerts?meta_account_id=eq.${encodeURIComponent(metaAccountId)}&resolved_at=is.null`,
      {
        method: "PATCH",
        body: JSON.stringify({
          resolved_at: now,
          updated_at: now,
          details: { lifecycle_resolution: "cooperation_ended" },
        }),
      },
    ),
  ]);

  const alertRows = await request<Array<{ id: number }>>(
    `performance_alerts?select=id&meta_account_id=eq.${encodeURIComponent(metaAccountId)}`
  );
  const alertIds = alertRows.map((row) => row.id);
  if (alertIds.length) {
    await request(
      `personal_tasks?performance_alert_id=in.(${alertIds.join(",")})&status=eq.active`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "cancelled",
          cancelled_at: now,
          next_followup_at: null,
          updated_at: now,
        }),
      },
    );
  }

  return getProjectLifecycle(metaAccountId);
}
