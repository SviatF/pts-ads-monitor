import { classifyAccountStatus, getBusinessAccounts, getRejectedAds } from "@/lib/meta";
import {
  listSeenRejectedAdIds,
  listStoredAccounts,
  rememberRejectedAds,
  type StoredAccount,
  type StoredRejectedAd,
  upsertAccounts,
} from "@/lib/store";
import {
  accountProblemMessage,
  accountRestoredMessage,
  newAccountAddedMessage,
  rejectedAdsMessage,
  sendTelegram,
} from "@/lib/telegram";

export type MonitorResult = {
  ok: boolean;
  startedAt: string;
  checkedAccounts: number;
  accountAlerts: number;
  rejectedAdsFound: number;
  rejectedAlerts: number;
  errors: string[];
};

export async function runMonitor(): Promise<MonitorResult> {
  const startedAt = new Date().toISOString();
  const accounts = await getBusinessAccounts();
  const result = {
    checkedAccounts: accounts.length,
    accountAlerts: 0,
    rejectedAdsFound: 0,
    rejectedAlerts: 0,
    errors: [] as string[],
  };

  const previousAccounts = await listStoredAccounts();
  const previousByAccount = new Map(previousAccounts.map((row) => [row.meta_account_id, row]));
  const rows: StoredAccount[] = [];
  const accountAlerts: string[] = [];

  for (const account of accounts) {
    const previous = previousByAccount.get(account.id) || null;
    const status = classifyAccountStatus(account.account_status);
    const changed = !previous || previous.account_status !== account.account_status;
    const statusChangedAt = changed ? startedAt : previous?.status_changed_at || startedAt;

    rows.push({
      meta_account_id: account.id,
      name: account.name,
      account_status: account.account_status,
      status_label: status.label,
      status_kind: status.kind,
      last_checked_at: startedAt,
      status_changed_at: statusChangedAt,
    });

    if (!previous) {
      accountAlerts.push(newAccountAddedMessage(account.name, account.id));
    } else if (changed) {
      if (status.kind === "active" && previous.account_status !== 1) {
        accountAlerts.push(accountRestoredMessage(account.name, account.id));
      } else if (status.kind !== "active") {
        accountAlerts.push(accountProblemMessage({ name: account.name, id: account.id, label: status.label, kind: status.kind }));
      }
    }
  }

  await upsertAccounts(rows);

  for (const message of accountAlerts) {
    try {
      await sendTelegram(message);
      result.accountAlerts++;
    } catch (error) {
      result.errors.push(`Telegram status alert: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const seenRejectIds = await listSeenRejectedAdIds();
  const rejectsToRemember: StoredRejectedAd[] = [];
  const rejectAlerts: Array<{ accountName: string; accountId: string; names: string[] }> = [];

  for (const account of accounts) {
    try {
      const previous = previousByAccount.get(account.id) || null;
      const rejectedAds = await getRejectedAds(account.id);
      result.rejectedAdsFound += rejectedAds.length;
      const firstAccountScan = !previous;
      const newRejectNames: string[] = [];

      for (const ad of rejectedAds) {
        if (seenRejectIds.has(ad.id)) continue;
        seenRejectIds.add(ad.id);
        rejectsToRemember.push({
          ad_id: ad.id,
          ad_name: ad.name,
          meta_account_id: account.id,
          account_name: account.name,
          first_seen_at: startedAt,
        });
        if (!firstAccountScan || process.env.ALERT_EXISTING_REJECTS === "true") {
          newRejectNames.push(ad.name);
        }
      }

      if (newRejectNames.length) {
        rejectAlerts.push({ accountName: account.name, accountId: account.id, names: newRejectNames });
      }
    } catch (error) {
      result.errors.push(`${account.name} ads: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await rememberRejectedAds(rejectsToRemember);
  } catch (error) {
    result.errors.push(`Rejected ads storage: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const alert of rejectAlerts) {
    try {
      await sendTelegram(rejectedAdsMessage(alert.accountName, alert.accountId, alert.names));
      result.rejectedAlerts += alert.names.length;
    } catch (error) {
      result.errors.push(`Telegram reject alert: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: result.errors.length === 0, startedAt, ...result };
}
