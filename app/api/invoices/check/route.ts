import { NextRequest, NextResponse } from "next/server";
import { hasDeliveredInvoice } from "@/lib/invoice-store";

export const dynamic = "force-dynamic";

function ok(request: NextRequest) {
  const configured = process.env.INVOICE_RUNNER_SECRET;
  return !!configured && request.headers.get("authorization") === `Bearer ${configured}`;
}

export async function GET(request: NextRequest) {
  if (!ok(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chat_id");
  const adAccountId = searchParams.get("ad_account_id");
  const invoiceKey = searchParams.get("invoice_key");
  if (!chatId || !adAccountId || !invoiceKey) {
    return NextResponse.json({ error: "Missing query parameters" }, { status: 400 });
  }
  const delivered = await hasDeliveredInvoice(chatId, adAccountId, invoiceKey);
  return NextResponse.json({ delivered });
}
