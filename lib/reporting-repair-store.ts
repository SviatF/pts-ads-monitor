export type ReportingRepairJob = {
  id: number;
  meta_account_id: string;
  project_name: string;
  status: "pending" | "running" | "healthy" | "mismatch" | "failed";
  repair_from: string | null;
  repair_to: string | null;
  expected_spend: number | null;
  expected_results: number | null;
  verified_spend: number | null;
  verified_results: number | null;
  mismatch_details: unknown;
  last_error: string | null;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
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
  if (!response.ok) throw new Error(`Supabase reporting repair request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function listPendingReportingRepairJobs(limit = 2) {
  return await request<ReportingRepairJob[]>(
    `reporting_repair_jobs?select=*&status=in.(pending,failed)&attempts=lt.3&order=attempts.asc,updated_at.asc&limit=${Math.max(1, Math.min(limit, 5))}`,
  );
}

export async function markReportingRepairRunning(id: number) {
  const now = new Date().toISOString();
  const rows = await request<ReportingRepairJob[]>(
    `reporting_repair_jobs?id=eq.${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "running",
        attempts_increment_placeholder: undefined,
        started_at: now,
        finished_at: null,
        last_error: null,
        updated_at: now,
      }),
    },
  );
  return rows[0] || null;
}

export async function incrementReportingRepairAttempt(id: number, currentAttempts: number) {
  const rows = await request<ReportingRepairJob[]>(
    `reporting_repair_jobs?id=eq.${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        attempts: currentAttempts + 1,
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  return rows[0] || null;
}

export async function finishReportingRepairJob(
  id: number,
  input: {
    status: "healthy" | "mismatch" | "failed";
    repairFrom?: string | null;
    repairTo?: string | null;
    expectedSpend?: number | null;
    expectedResults?: number | null;
    verifiedSpend?: number | null;
    verifiedResults?: number | null;
    mismatchDetails?: unknown;
    error?: string | null;
  },
) {
  const now = new Date().toISOString();
  const rows = await request<ReportingRepairJob[]>(
    `reporting_repair_jobs?id=eq.${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: input.status,
        repair_from: input.repairFrom ?? null,
        repair_to: input.repairTo ?? null,
        expected_spend: input.expectedSpend ?? null,
        expected_results: input.expectedResults ?? null,
        verified_spend: input.verifiedSpend ?? null,
        verified_results: input.verifiedResults ?? null,
        mismatch_details: input.mismatchDetails ?? null,
        last_error: input.error ? input.error.slice(0, 3000) : null,
        finished_at: now,
        updated_at: now,
      }),
    },
  );
  return rows[0] || null;
}

export async function getReportingRepairSummary() {
  const rows = await request<ReportingRepairJob[]>(
    "reporting_repair_jobs?select=*&order=project_name.asc",
  );
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  return { rows, counts };
}

export async function resetReportingRepairQueue() {
  const now = new Date().toISOString();
  return await request<ReportingRepairJob[]>(
    "reporting_repair_jobs?status=neq.running",
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "pending",
        attempts: 0,
        last_error: null,
        mismatch_details: null,
        finished_at: null,
        updated_at: now,
      }),
    },
  );
}
