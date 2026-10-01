import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string, init: RequestInit = {}) {
  const { url, key } = cfg();
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
  if (!response.ok) throw new Error(`Performance dismiss failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

type AlertRow = {
  id: number;
  details: Record<string, unknown> | null;
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid alert id" }, { status: 400 });
  }

  const rows = await request<AlertRow[]>(`performance_alerts?select=id,details&id=eq.${id}&limit=1`);
  const alert = rows[0];
  if (!alert) return NextResponse.json({ ok: false, error: "Alert not found" }, { status: 404 });

  const now = new Date();
  const suppressedUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const details = {
    ...(alert.details || {}),
    dashboard_dismissed: true,
    dismissed_at: now.toISOString(),
    dismissed_until: suppressedUntil.toISOString(),
    dismissed_by: "dashboard",
    dismiss_reason: "manual_negative_task_cancel",
  };

  await request(`performance_alerts?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      details,
      // A future resolved_at intentionally keeps the current incident closed for
      // the same seven-day suppression window. Existing monitor guards therefore
      // cannot resurrect it on the next 20-minute check.
      resolved_at: suppressedUntil.toISOString(),
      acknowledged_at: now.toISOString(),
      acknowledged_by: "dashboard:dismiss",
      last_notified_at: suppressedUntil.toISOString(),
      updated_at: now.toISOString(),
    }),
  });

  const target = new URL("/tasks", request.url);
  target.searchParams.set("dismissed", String(id));
  return NextResponse.redirect(target, 303);
}
