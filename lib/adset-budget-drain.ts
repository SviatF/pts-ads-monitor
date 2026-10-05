export type AdsetInsightRow = {
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  spend?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
};

export type AdsetBudgetDrainSignal = {
  campaignId: string;
  campaignName: string;
  weakAdsetId: string;
  weakAdsetName: string;
  weakSpend: number;
  weakResults: number;
  weakCpl: number | null;
  weakSpendShare: number;
  weakResultShare: number;
  winnerAdsetId: string;
  winnerAdsetName: string;
  winnerSpend: number;
  winnerResults: number;
  winnerCpl: number;
  cplRatio: number | null;
};

function resultFor(actions: AdsetInsightRow["actions"], actionType: string) {
  return Number((actions || []).find((item) => item.action_type === actionType)?.value || 0);
}

export function analyzeAdsetBudgetDrain(
  rows: AdsetInsightRow[],
  actionByCampaign: Map<string, string | null>,
) {
  const grouped = new Map<string, Map<string, {
    campaignId: string;
    campaignName: string;
    adsetId: string;
    adsetName: string;
    spend: number;
    results: number;
  }>>();

  for (const row of rows) {
    const campaignId = String(row.campaign_id || "");
    const adsetId = String(row.adset_id || "");
    const actionType = actionByCampaign.get(campaignId);
    if (!campaignId || !adsetId || !actionType) continue;

    let campaign = grouped.get(campaignId);
    if (!campaign) {
      campaign = new Map();
      grouped.set(campaignId, campaign);
    }
    const current = campaign.get(adsetId) || {
      campaignId,
      campaignName: row.campaign_name || "Без назви",
      adsetId,
      adsetName: row.adset_name || "Без назви",
      spend: 0,
      results: 0,
    };
    current.spend += Number(row.spend || 0);
    current.results += resultFor(row.actions, actionType);
    campaign.set(adsetId, current);
  }

  const signals: AdsetBudgetDrainSignal[] = [];

  for (const campaign of grouped.values()) {
    const adsets = [...campaign.values()].map((item) => ({
      ...item,
      cpl: item.results > 0 ? item.spend / item.results : Number.POSITIVE_INFINITY,
    }));
    if (adsets.length < 2) continue;

    const totalSpend = adsets.reduce((sum, item) => sum + item.spend, 0);
    const totalResults = adsets.reduce((sum, item) => sum + item.results, 0);
    if (totalSpend <= 0 || totalResults < 5) continue;

    const winners = adsets
      .filter((item) => item.results >= 3 && Number.isFinite(item.cpl) && item.cpl > 0)
      .sort((a, b) => a.cpl - b.cpl);
    const winner = winners[0];
    if (!winner) continue;

    const candidates = adsets.filter((item) => {
      if (item.adsetId === winner.adsetId) return false;
      const spendShare = item.spend / totalSpend;
      const resultShare = item.results / totalResults;
      const cplRatio = item.results > 0 ? item.cpl / winner.cpl : Number.POSITIVE_INFINITY;
      return (
        item.spend >= winner.cpl * 3 &&
        (item.results === 0 || cplRatio >= 2) &&
        spendShare >= 0.30 &&
        resultShare <= Math.max(0.5, spendShare - 0.15)
      );
    }).sort((a, b) => b.spend - a.spend);

    const weak = candidates[0];
    if (!weak) continue;

    const ratio = weak.results > 0 ? weak.cpl / winner.cpl : Number.POSITIVE_INFINITY;
    signals.push({
      campaignId: weak.campaignId,
      campaignName: weak.campaignName,
      weakAdsetId: weak.adsetId,
      weakAdsetName: weak.adsetName,
      weakSpend: weak.spend,
      weakResults: weak.results,
      weakCpl: weak.results > 0 ? weak.cpl : null,
      weakSpendShare: weak.spend / totalSpend,
      weakResultShare: weak.results / totalResults,
      winnerAdsetId: winner.adsetId,
      winnerAdsetName: winner.adsetName,
      winnerSpend: winner.spend,
      winnerResults: winner.results,
      winnerCpl: winner.cpl,
      cplRatio: Number.isFinite(ratio) ? ratio : null,
    });
  }

  return signals;
}