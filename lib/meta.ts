const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type MetaAccount = {
  id: string;
  name: string;
  account_status: number;
  currency?: string;
  timezone_name?: string;
};

export type MetaAd = {
  id: string;
  name: string;
  effective_status: string;
};

function token() {
  const value = process.env.META_ACCESS_TOKEN;
  if (!value) throw new Error("META_ACCESS_TOKEN is not configured");
  return value;
}

async function graph<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("access_token", token());

  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `Meta API request failed: ${response.status}`);
  }
  return body as T;
}

async function readAllPages<T>(firstPath: string, params: Record<string, string>): Promise<T[]> {
  const first = await graph<{ data: T[]; paging?: { next?: string } }>(firstPath, params);
  const data = [...(first.data || [])];
  let next = first.paging?.next;

  while (next) {
    const response = await fetch(next, { cache: "no-store" });
    const page = await response.json();
    if (!response.ok || page?.error) throw new Error(page?.error?.message || "Meta pagination failed");
    data.push(...(page.data || []));
    next = page.paging?.next;
  }
  return data;
}

export async function getBusinessAccounts(): Promise<MetaAccount[]> {
  const businessId = process.env.META_BUSINESS_ID;
  if (!businessId) throw new Error("META_BUSINESS_ID is not configured");

  const params = { fields: "id,name,account_status,currency,timezone_name", limit: "200" };
  const [owned, clients] = await Promise.all([
    readAllPages<MetaAccount>(`${businessId}/owned_ad_accounts`, params),
    readAllPages<MetaAccount>(`${businessId}/client_ad_accounts`, params),
  ]);

  const unique = new Map<string, MetaAccount>();
  [...owned, ...clients].forEach((account) => unique.set(account.id, account));
  return [...unique.values()];
}

export async function getRejectedAds(accountId: string): Promise<MetaAd[]> {
  return readAllPages<MetaAd>(`${accountId}/ads`, {
    fields: "id,name,effective_status",
    effective_status: JSON.stringify(["DISAPPROVED"]),
    limit: "200",
  });
}

export function classifyAccountStatus(code: number) {
  const labels: Record<number, { label: string; kind: "active" | "payment" | "problem" | "warning" }> = {
    1: { label: "ACTIVE", kind: "active" },
    2: { label: "DISABLED", kind: "problem" },
    3: { label: "UNSETTLED", kind: "payment" },
    7: { label: "PENDING_RISK_REVIEW", kind: "warning" },
    8: { label: "PENDING_SETTLEMENT", kind: "payment" },
    9: { label: "IN_GRACE_PERIOD", kind: "payment" },
    100: { label: "PENDING_CLOSURE", kind: "problem" },
    101: { label: "CLOSED", kind: "problem" },
  };
  return labels[code] || { label: `STATUS_${code}`, kind: "problem" as const };
}
