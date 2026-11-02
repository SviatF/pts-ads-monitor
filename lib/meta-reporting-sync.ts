import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { dailyBlocksForDays } from "@/lib/report-template";
import { applyReportFormulas } from "@/lib/report-formulas";
import { dayIndexInPeriod, parseIsoDate, periodForDate, periodLength } from "@/lib/report-periods";
import { syncCampaignPerformanceSheets, type CampaignPerformanceRow } from "@/lib/campaign-report-sheet";
import { normalizeReportingCurrency } from "@/lib/report-currency";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaAction = { action_type?: string; value?: string };
type MetaInsight = { campaign_id?: string; campaign_name?: string; spend?: string; actions?: MetaAction[]; date_start: string; date_stop?: string };
type MetaPage<T> = { data?: T[]; paging?: { next?: string }; error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean; fbtrace_id?: string } };
type Channel = "direct" | "leadform" | "quiz" | "site";

const CHANNEL_ROW_OFFSET: Record<Channel, number> = { direct: 1, leadform: 2, quiz: 3, site: 4 };

const RESULT_ACTION_PRIORITY: Record<Channel, string[]> = {
  direct: ["onsite_conversion.messaging_conversation_started_7d", "messaging_conversation_started_7d", "onsite_conversion.messaging_first_reply", "lead", "contact"],
  leadform: ["onsite_conversion.lead_grouped", "lead", "offsite_conversion.fb_pixel_lead", "contact"],
  quiz: ["offsite_conversion.fb_pixel_lead", "lead", "onsite_conversion.contact_website", "offsite_conversion.fb_pixel_contact", "contact"],
  site: ["offsite_conversion.fb_pixel_lead", "lead", "onsite_conversion.contact_website", "offsite_conversion.fb_pixel_contact", "contact"],
};

const GENERIC_RESULT_ACTION_PRIORITY = [
  "onsite_conversion.messaging_conversation_started_7d",
  "messaging_conversation_started_7d",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "lead",
  "onsite_conversion.contact_website",
  "offsite_conversion.fb_pixel_contact",
  "contact",
];

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
  if (/\bdirect\b|\bmessenger\b|\bmessages?\b|\bdm\b/i.test(normalized)) return "direct";
  if (/\bquiz\b/i.test(normalized)) return "quiz";
  if (/\bsite\b|\bwebsite\b|\bweb\s*site\b|\bweb\b/i.test(normalized)) return "site";
  if (/\bleads?\s*form\b|\bleadform\b|\binstant\s*form\b/i.test(normalized)) return "leadform";
  if (/\bleads?\b/i.test(normalized)) return "leadform";
  return null;
}

function actionMap(actions: MetaAction[] | undefined) {
  return new Map((actions || []).map((item) => [item.action_type || "", Number(item.value || 0)]));
}

function resultCount(channel: Channel, actions: MetaAction[] | undefined) {
  const byType = actionMap(actions);
  for (const actionType of RESULT_ACTION_PRIORITY[channel]) {
    if (byType.has(actionType)) return { value: Number(byType.get(actionType) || 0), actionType };
  }
  return { value: 0, actionType: null as string | null };
}

function genericResultCount(actions: MetaAction[] | undefined) {
  const byType = actionMap(actions);
  for (const actionType of GENERIC_RESULT_ACTION_PRIORITY) {
    if (byType.has(actionType)) return Number(byType.get(actionType) || 0);
  }
  return 0;
}

const META_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const META_TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613]);

function metaRetryable(status: number, error?: MetaPage<unknown>["error"]) {
  return META_RETRY_STATUSES.has(status) ||
    error?.is_transient === true ||
    (typeof error?.code === "number" && META_TRANSIENT_CODES.has(error.code));
}

function metaErrorDescription(status: number, error?: MetaPage<unknown>["error"]) {
  const message = error?.message || `HTTP ${status}`;
  const code = typeof error?.code === "number" ? ` · code ${error.code}` : "";
  const subcode = typeof error?.error_subcode === "number" ? ` · subcode ${error.error_subcode}` : "";
  const trace = error?.fbtrace_id ? ` · trace ${error.fbtrace_id}` : "";
  return `Meta Graph API (${status}${code}${subcode}): ${message}${trace}`;
}

async function metaGraphAll<T>(path: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\\//, "")}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("access_token", metaToken());
  const rows: T[] = [];
  let next: string | null = url.toString();
  let pages = 0;
  while (next) {
    let page: MetaPage<T> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(next, { cache: "no-store" });
      } catch (error) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 800));
          continue;
        }
        throw new Error(`Meta Graph API network failure: ${error instanceof Error ? error.message : String(error)}`);
      }
      const raw = await response.text();
      let result: MetaPage<T>;
      try {
        result = JSON.parse(raw) as MetaPage<T>;
      } catch {
        // Avoid leaking full response content or OAuth credentials into logs.
        if (metaRetryable(response.status) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 800));
          continue;
        }
        throw new Error(`Meta Graph API (${response.status}): unexpected non-JSON response`);
      }
      if (!response.ok || result.error) {
        if (metaRetryable(response.status, result.error) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 800));
          continue;
        }
        throw new Error(metaErrorDescription(response.status, result.error));
      }
      page = result;
      break;
    }
    if (!page) throw new Error("Meta Graph API: retries exhausted");
    rows.push(...(page.data || []));
    next = page.paging?.next || null;
    if (++pages > 1000) throw new Error("Meta Graph API: pagination limit exceeded");
  }
  return rows;
}

async function googleValuesBatchUpdate(spreadsheetId: string, data: Array<{ range: string; values: Array<Array<string | number>> }>) {
  if (!data.length) return;
  const token = await getGoogleUserAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${text}`);
}

function quoteSheet(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

function channelLabel(channel: Channel | null) {
  if (channel === "direct") return "Direct / Messenger";
  if (channel === "leadform") return "Lead Form";
  if (channel === "quiz") return "Quiz";
  if (channel === "site") return "Site";
  return "Unmapped";
}

function monthStartIso(iso: string) {
  const [year, month] = iso.split("-");
  return `${year}-${month}-01`;
}

export async function syncMetaReporting(input: { accountId: string; spreadsheetId: string; since: string; until: string; currency?: string | null }) {
  const currency = normalizeReportingCurrency(input.currency || "USD");

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
  let unmappedSpend = 0;
  let unmappedResults = 0;
  let untilSpend = 0;
  let untilLeads = 0;

  for (const insight of insights) {
    const name = insight.campaign_name || "(unnamed campaign)";
    const channel = mapCampaignToChannel(name);
    const spend = Number(insight.spend || 0);
    const mappedResult = channel ? resultCount(channel, insight.actions) : null;
    const detailResults = mappedResult ? mappedResult.value : genericResultCount(insight.actions);

    if (!channel) {
      unmapped.add(name);
      unmappedSpend += spend;
      unmappedResults += detailResults;
      continue;
    }

    const result = mappedResult || { value: 0, actionType: null };
    const leads = result.value;
    if (result.actionType) resultActionTypes.set(result.actionType, (resultActionTypes.get(result.actionType) || 0) + 1);
    mappedCampaigns.add(name);
    mappedSpend += spend;
    mappedLeads += leads;
    if (insight.date_start === input.until) {
      untilSpend += spend;
      untilLeads += leads;
    }
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
    const period = periodForDate(date);
    const dayIndex = dayIndexInPeriod(date, period);
    const blocks = dailyBlocksForDays(periodLength(period));
    const block = blocks[dayIndex];
    if (!block) continue;
    const sheet = quoteSheet(period.title);
    for (const channel of Object.keys(CHANNEL_ROW_OFFSET) as Channel[]) {
      const row = block.dataStartRow + CHANNEL_ROW_OFFSET[channel];
      const values = aggregate.get(`${iso}|${channel}`) || { leads: 0, spend: 0 };
      // C = Meta Result (automatic). B is reserved strictly for manager-entered general leads.
      data.push({ range: `${sheet}!C${row}`, values: [[values.leads]] });
      data.push({ range: `${sheet}!E${row}`, values: [[Number(values.spend.toFixed(2))]] });
    }
  }

  await googleValuesBatchUpdate(input.spreadsheetId, data);
  await applyReportFormulas(input.spreadsheetId);

  // Campaign detail sheets are rebuilt from a complete month window, not from
  // only the most recent daily sync. Previously the sheet was cleared and then
  // rewritten with just one day, which made month/week totals collapse to the
  // last synced date.
  const campaignDetailSince = monthStartIso(input.since);
  const campaignInsights = await metaGraphAll<MetaInsight>(`${objectId}/insights`, {
    level: "campaign",
    fields: "campaign_id,campaign_name,spend,actions,date_start,date_stop",
    time_increment: "1",
    time_range: JSON.stringify({ since: campaignDetailSince, until: input.until }),
    limit: "500",
  });
  const campaignRows: CampaignPerformanceRow[] = campaignInsights.flatMap((insight) => {
    const name = insight.campaign_name || "(unnamed campaign)";
    const channel = mapCampaignToChannel(name);
    if (!channel) return [];
    return [{
      date: insight.date_start,
      campaignId: insight.campaign_id || name,
      campaignName: name,
      channel: channelLabel(channel),
      spend: Number(insight.spend || 0),
      results: resultCount(channel, insight.actions).value,
    }];
  });

  const campaignDetail = await syncCampaignPerformanceSheets(input.spreadsheetId, campaignRows, currency);

  return {
    insightRows: insights.length,
    mappedCampaigns: [...mappedCampaigns],
    unmappedCampaigns: [...unmapped],
    resultActionTypes: [...resultActionTypes.entries()].map(([actionType, rows]) => ({ actionType, rows })),
    mappedSpend: Number(mappedSpend.toFixed(2)),
    mappedLeads,
    unmappedSpend: Number(unmappedSpend.toFixed(2)),
    unmappedResults,
    untilSpend: Number(untilSpend.toFixed(2)),
    untilLeads,
    cellsWritten: data.length,
    campaignDetail,
    since: input.since,
    until: input.until,
  };
}
