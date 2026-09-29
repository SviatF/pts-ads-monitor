import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { PTS_REPORT_TEMPLATE } from "@/lib/report-template";
import { applyReportFormulas } from "@/lib/report-formulas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaAction = { action_type?: string; value?: string };
type MetaInsight = {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  actions?: MetaAction[];
  date_start: string;
  date_stop?: string;
};

type MetaPage<T> = {
  data?: T[];
  paging?: { next?: string };
  error?: { message?: string };
};

type Channel = "direct" | "leadform" | "quiz" | "site";

const CHANNEL_ROW_OFFSET: Record<Channel, number> = {
  direct: 1,
  leadform: 2,
  quiz: 3,
  site: 4,
};

// Meta Ads Manager's Results column is not one universal "lead" metric.
// Choose the action type that corresponds to the landing/channel first,
// then fall back to broader lead/contact actions only if needed.
const RESULT_ACTION_PRIORITY: Record<Channel, string[]> = {
  direct: [
    "onsite_conversion.messaging_conversation_started_7d",
    "messaging_conversation_started_7d",
    "onsite_conversion.messaging_first_reply",
    "lead",
    "contact",
  ],
  leadform: [
    "onsite_conversion.lead_grouped",
    "lead",
    "offsite_conversion.fb_pixel_lead",
    "contact",
  ],
  quiz: [
    "offsite_conversion.fb_pixel_lead",
    "lead",
    "onsite_conversion.contact_website",
    "offsite_conversion.fb_pixel_contact",
    "contact",
  ],
  site: [
    "offsite_conversion.fb_pixel_lead",
    "lead",
    "onsite_conversion.contact_website",
    "offsite_conversion.fb_pixel_contact",
    "contact",
  ],
};

function metaToken() {
  const value = process.env.META_ACCESS_TOKEN;
  if (!value) throw new Error("META_ACCESS_TOKEN is not configured");
  return value;
}

function normalizeCampaignName(name: string) {
  return name.toLowerCase().replace(/[\s_\-:|]+/g, " ").trim();
}

export function mapCampaignToChannel(name: string): Channel | null {
  const normalized = normalizeCampaignName(name);

  // Specific intent words win over generic lead/leads words.
  if (/\bdirect\b|\bmessenger\b|\bmessages?\b|\bdm\b/i.test(normalized)) return "direct";
  if (/\bquiz\b/i.test(normalized)) return "quiz";
  if (/\bsite\b|\bwebsite\b|\bweb\s*site\b|\bweb\b/i.test(normalized)) return "site";
  if (/\bleads?\s*form\b|\bleadform\b|\binstant\s*form\b/i.test(normalized)) return "leadform";

  // Legacy PTS campaigns are sometimes named simply "Leads: ..." while the Result is Lead (Form).
  if (/\bleads?\b/i.test(normalized)) return "leadform";

  return null;
}

function resultCount(channel: Channel, actions: MetaAction[] | undefined) {
  const byType = new Map((actions || []).map((item) => [item.action_type || "", Number(item.value || 0)]));
  for (const actionType of RESULT_ACTION_PRIORITY[channel]) {
    if (byType.has(actionType)) {
      return { value: Number(byType.get(actionType) || 0), actionType };
    }
  }
  return { value: 0, actionType: null as string | null };
}

async function metaGraphAll<T>(path: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("access_token", metaToken());

  const rows: T[] = [];
  let next: string | null = url.toString();
  while (next) {
    const response: Response = await fetch(next, { cache: "no-store" });
    const body = (await response.json()) as MetaPage<T>;
    if (!response.ok || body.error) {
      throw new Error(body.error?.message || `Meta API request failed (${response.status})`);
    }
    rows.push(...(body.data || []));
    next = body.paging?.next || null;
  }
  return rows;
}

async function googleValuesBatchUpdate(
  spreadsheetId: string,
  data: Array<{ range: string; values: Array<Array<string | number>> }>,
) {
  if (!data.length) return;
  const token = await getGoogleUserAccessToken();
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${text}`);
}

function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function shortDate(date: Date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function endOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function weeklySheetForDate(value: string) {
  const date = parseIsoDate(value);
  const day = date.getUTCDate();
  const startDay = day <= 7 ? 1 : day <= 14 ? 8 : day <= 21 ? 15 : day <= 28 ? 22 : 29;
  const endDay = Math.min(startDay + 6, endOfMonth(date).getUTCDate());
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), startDay));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), endDay));
  return { title: `${shortDate(start)}–${shortDate(end)}`, dayIndex: day - startDay };
}

function quoteSheet(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

export async function syncMetaReporting(input: {
  accountId: string;
  spreadsheetId: string;
  since: string;
  until: string;
}) {
  await applyReportFormulas(input.spreadsheetId);

  const objectId = input.accountId.startsWith("act_") ? input.accountId : `act_${input.accountId}`;
  const insights = await metaGraphAll<MetaInsight>(`${objectId}/insights`, {
    level: "campaign",
    fields: "campaign_id,campaign_name,spend,actions,date_start,date_stop",
    time_increment: "1",
    time_range: JSON.stringify({ since: input.since, until: input.until }),
    limit: "500",
  });

  const aggregate = new Map<string, { leads: number; spend: number }>();
  const unmapped = new Set<string>();
  const mappedCampaigns = new Set<string>();
  const resultActionTypes = new Map<string, number>();
  let mappedSpend = 0;
  let mappedLeads = 0;

  for (const insight of insights) {
    const name = insight.campaign_name || "(unnamed campaign)";
    const channel = mapCampaignToChannel(name);
    if (!channel) {
      unmapped.add(name);
      continue;
    }

    const result = resultCount(channel, insight.actions);
    const leads = result.value;
    const spend = Number(insight.spend || 0);
    if (result.actionType) {
      resultActionTypes.set(result.actionType, (resultActionTypes.get(result.actionType) || 0) + 1);
    }
    mappedCampaigns.add(name);
    mappedSpend += spend;
    mappedLeads += leads;

    const key = `${insight.date_start}|${channel}`;
    const current = aggregate.get(key) || { leads: 0, spend: 0 };
    current.leads += leads;
    current.spend += spend;
    aggregate.set(key, current);
  }

  const since = parseIsoDate(input.since);
  const until = parseIsoDate(input.until);
  const data: Array<{ range: string; values: Array<Array<string | number>> }> = [];

  for (let date = new Date(since); date <= until; date.setUTCDate(date.getUTCDate() + 1)) {
    const iso = date.toISOString().slice(0, 10);
    const { title, dayIndex } = weeklySheetForDate(iso);
    if (dayIndex < 0 || dayIndex >= PTS_REPORT_TEMPLATE.daily.blocks.length) continue;
    const block = PTS_REPORT_TEMPLATE.daily.blocks[dayIndex];
    const sheet = quoteSheet(title);

    for (const channel of Object.keys(CHANNEL_ROW_OFFSET) as Channel[]) {
      const row = block.dataStartRow + CHANNEL_ROW_OFFSET[channel];
      const values = aggregate.get(`${iso}|${channel}`) || { leads: 0, spend: 0 };
      data.push({ range: `${sheet}!B${row}`, values: [[values.leads]] });
      data.push({ range: `${sheet}!E${row}`, values: [[Number(values.spend.toFixed(2))]] });
    }
  }

  await googleValuesBatchUpdate(input.spreadsheetId, data);
  await applyReportFormulas(input.spreadsheetId);

  return {
    insightRows: insights.length,
    mappedCampaigns: [...mappedCampaigns],
    unmappedCampaigns: [...unmapped],
    resultActionTypes: [...resultActionTypes.entries()].map(([actionType, rows]) => ({ actionType, rows })),
    mappedSpend: Number(mappedSpend.toFixed(2)),
    mappedLeads,
    cellsWritten: data.length,
    since: input.since,
    until: input.until,
  };
}
