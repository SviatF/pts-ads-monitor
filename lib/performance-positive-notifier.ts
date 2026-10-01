import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";
import { escapeTelegramHtml } from "@/lib/invoice-telegram";
import { sendPerformanceMessage } from "@/lib/performance-telegram";

type WinnerAlert = {
  id: number;
  meta_account_id: string;
  title: string;
  details: Record<string, unknown> | null;
  last_seen_at: string;
  resolved_at: string | null;
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
  if (!response.ok) throw new Error(`Winner notifier request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function number(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function creativeName(row: WinnerAlert) {
  const raw = row.title.replace(/^Winner\s*[—-]\s*/i, "").trim();
  return raw || String(row.details?.adName || row.details?.adId || "Creative");
}

export async function notifyConfirmedWinnerCreatives() {
  const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const [rows, configs] = await Promise.all([
    request<WinnerAlert[]>(`performance_alerts?select=id,meta_account_id,title,details,last_seen_at,resolved_at&alert_type=eq.CREATIVE_WINNER_V4&resolved_at=is.null&last_seen_at=gte.${encodeURIComponent(since)}&order=last_seen_at.desc&limit=50`),
    listPerformanceMonitoringConfigs(),
  ]);
  const names = new Map(configs.map((item) => [item.meta_account_id, item.project_name]));
  let sent = 0;

  for (const row of rows) {
    const details = row.details || {};
    if (details.winner_notified_at) continue;
    const results = number(details.results);
    const winnerCpl = number(details.cpl);
    const baselineCpl = number(details.targetCpl);
    if (results < 5 || winnerCpl <= 0 || baselineCpl <= 0) continue;

    const project = names.get(row.meta_account_id) || row.meta_account_id;
    const improvement = Math.max(0, 1 - winnerCpl / baselineCpl);
    await sendPerformanceMessage(
      `🏆 <b>WINNER CREATIVE / СИЛЬНИЙ КРЕАТИВ</b>\n` +
      `Проєкт: <b>${escapeTelegramHtml(project)}</b>\n` +
      `Creative: <b>${escapeTelegramHtml(creativeName(row))}</b>\n` +
      `3d: <b>${results} results · $${winnerCpl.toFixed(2)} CPL</b>\n` +
      `Сильніше baseline приблизно на <b>${Math.round(improvement * 100)}%</b>.\n` +
      `Сигнал підтверджений за 3 повні дні — можна розглядати для масштабування.`
    );

    await request(`performance_alerts?id=eq.${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        details: { ...details, winner_notified_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }),
    });
    sent += 1;
  }

  return { sent };
}
