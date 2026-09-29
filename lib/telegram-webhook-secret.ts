export function telegramWebhookSecret() {
  const raw = process.env.TELEGRAM_WEBHOOK_SECRET || process.env.INVOICE_RUNNER_SECRET;
  if (!raw) return null;

  const safe = raw
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 256);

  return safe || "pts_webhook";
}
