import { classifyAccountStatus, getBusinessAccounts, getRejectedAds } from "@/lib/meta";
import { getStoredAccount, hasSeenRejectedAd, rememberRejectedAd, upsertAccount } from "@/lib/store";
import { accountProblemMessage, accountRestoredMessage, rejectedAdsMessage, sendTelegram } from "@/lib/telegram";

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

  for (const account of accounts) {
    try {
      const previous = await getStoredAccount(account.id);
      const status = classifyAccountStatus(account.account_status);
      const changed = !previous || previous.account_status !== account.account_status;
      const statusChangedAt = changed ? startedAt : previous?.status_changed_at || startedAt;

      if (changed) {
        if (status.kind === "active" && previous && previous.account_status !== 1) {
          await sendTelegram(accountRestoredMessage(account.name, account.id));
          result.accountAlerts++;
        } else if (status.kind !== "active") {
          await sendTelegram(accountProblemMessage({ name: account.name, id: account.id, label: status.label, kind: status.kind }));
          result.accountAlerts++;
        }
      }

      await upsertAccount({
        meta_account_id: account.id,
        name: account.name,
        account_status: account.account_status,
        status_label: status.label,
        status_kind: status.kind,
        last_checked_at: startedAt,
        status_changed_at: statusChangedAt,
      });

      const rejectedAds = await getRejectedAds(account.id);
      result.rejectedAdsFound += rejectedAds.length;
      const firstAccountScan = !previous;
      const newRejectNames: string[] = [];

      for (const ad of rejectedAds) {
        const seen = await hasSeenRejectedAd(ad.id);
        if (!seen) {
          await rememberRejectedAd({
            ad_id: ad.id,
            ad_name: ad.name,
            meta_account_id: account.id,
            account_name: account.name,
            first_seen_at: startedAt,
          });
          if (!firstAccountScan || process.env.ALERT_EXISTING_REJECTS === "true") newRejectNames.push(ad.name);
        }
      }

      if (newRejectNames.length) {
        await sendTelegram(rejectedAdsMessage(account.name, account.id, newRejectNames));
        result.rejectedAlerts += newRejectNames.length;
      }
    } catch (error) {
      result.errors.push(`${account.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: result.errors.length === 0, startedAt, ...result };
}
