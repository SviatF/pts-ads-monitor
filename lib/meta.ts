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

export type MetaBusinessInvoice = {
  id?: string;
  invoice_id?: string;
  billing_period?: string;
  invoice_date?: string;
  due_date?: string;
  payment_status?: string;
  amount_due?: string | number | null;
  type?: string;
  invoice_type?: string;
  entity?: string;
  payment_term?: string;
  download_uri?: string;
  cdn_download_uri?: string;
  billed_amount_details?: {
    currency?: string;
    net_amount?: string | number;
    tax_amount?: string | number;
    total_amount?: string | number;
  };
  campaigns?: {
    data?: Array<{
      campaign_id?: string;
      campaign_name?: string;
      billed_amount_details?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
  };
  [key: string]: unknown;
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
    const error = body?.error;
    const message = error?.message || `Meta API request failed: ${response.status}`;
    const details = [error?.type, error?.code != null ? `code=${error.code}` : null, error?.error_subcode != null ? `subcode=${error.error_subcode}` : null]
      .filter(Boolean)
      .join(", ");
    throw new Error(details ? `${message} (${details})` : message);
  }
  return body as T;
}

async function graphProbe(path: string, params: Record<string, string> = {}) {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("access_token", token());

  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    const error = body?.error;
    return {
      ok: false as const,
      status: response.status,
      error: error?.message || `Meta API request failed: ${response.status}`,
      code: error?.code ?? null,
      subcode: error?.error_subcode ?? null,
    };
  }
  return { ok: true as const, status: response.status, body };
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

const accountParams = { fields: "id,name,account_status,currency,timezone_name", limit: "200" };

export async function getAccountDiscoveryDiagnostics() {
  const businessId = process.env.META_BUSINESS_ID;
  if (!businessId) throw new Error("META_BUSINESS_ID is not configured");

  const [owned, clients, directlyAccessible] = await Promise.all([
    readAllPages<MetaAccount>(`${businessId}/owned_ad_accounts`, accountParams),
    readAllPages<MetaAccount>(`${businessId}/client_ad_accounts`, accountParams),
    readAllPages<MetaAccount>("me/adaccounts", accountParams),
  ]);

  const unique = new Map<string, MetaAccount>();
  [...owned, ...clients, ...directlyAccessible].forEach((account) => unique.set(account.id, account));

  return {
    businessId,
    owned,
    clients,
    directlyAccessible,
    unique: [...unique.values()],
  };
}

export async function getBusinessAccounts(): Promise<MetaAccount[]> {
  const diagnostics = await getAccountDiscoveryDiagnostics();
  return diagnostics.unique;
}

export async function getRejectedAds(accountId: string): Promise<MetaAd[]> {
  return readAllPages<MetaAd>(`${accountId}/ads`, {
    fields: "id,name,effective_status",
    effective_status: JSON.stringify(["DISAPPROVED"]),
    limit: "200",
  });
}

export async function getBusinessInvoices(input: { startDate: string; endDate: string; invoiceId?: string | null }) {
  const businessId = process.env.META_BUSINESS_ID;
  if (!businessId) throw new Error("META_BUSINESS_ID is not configured");

  const fields = [
    "id",
    "invoice_id",
    "billing_period",
    "invoice_date",
    "due_date",
    "payment_status",
    "amount_due",
    "type",
    "invoice_type",
    "entity",
    "payment_term",
    "billed_amount_details",
    "download_uri",
    "cdn_download_uri",
    "campaigns",
  ].join(",");

  const params: Record<string, string> = {
    fields,
    start_date: input.startDate,
    end_date: input.endDate,
    limit: "100",
  };
  if (input.invoiceId) params.invoice_id = input.invoiceId;

  const invoices = await readAllPages<MetaBusinessInvoice>(`${businessId}/business_invoices`, params);
  return { businessId, graphVersion: GRAPH_VERSION, invoices };
}

export async function getAdAccountBillingDiagnostics(accountIdInput: string) {
  const accountId = accountIdInput.replace(/^act_/, "");
  const objectId = `act_${accountId}`;

  const account = await graph<Record<string, unknown>>(objectId, {
    fields: "id,name,business,business_name,account_status,amount_spent,balance,currency,spend_cap,timezone_name",
  });

  const probes = await Promise.all([
    graphProbe(`${objectId}/transactions`, { limit: "10" }).then((result) => ({ edge: "transactions", documented: false, result })),
    graphProbe(`${objectId}/payment_activity`, { limit: "10" }).then((result) => ({ edge: "payment_activity", documented: false, result })),
  ]);

  return {
    graphVersion: GRAPH_VERSION,
    accountId,
    account,
    probes,
  };
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
