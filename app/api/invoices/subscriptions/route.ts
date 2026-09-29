import { NextRequest, NextResponse } from "next/server";
import { listInvoiceSubscriptions } from "@/lib/invoice-store";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const secret = process.env.INVOICE_RUNNER_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subscriptions = await listInvoiceSubscriptions();
  return NextResponse.json({ subscriptions });
}
