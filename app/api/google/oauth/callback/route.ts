import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleCode } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

function page(title: string, body: string, ok = true) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#0a0a0a;color:#f5f5f5;font-family:Inter,system-ui;padding:40px"><div style="max-width:820px;margin:auto;border:1px solid #2b2b2b;border-radius:18px;padding:28px;background:#111"><div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#8d8d8d">PTS Reporting · Google OAuth</div><h1 style="margin:12px 0 18px">${title}</h1>${body}</div></body></html>`,
    { status: ok ? 200 : 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: NextRequest) {
  const error = request.nextUrl.searchParams.get("error");
  if (error) return page("Google authorization failed", `<p>${error}</p>`, false);

  const code = request.nextUrl.searchParams.get("code");
  if (!code) return page("Missing authorization code", "<p>Google did not return an authorization code.</p>", false);

  try {
    const tokens = await exchangeGoogleCode(code);
    if (!tokens.refresh_token) {
      return page(
        "No refresh token returned",
        "<p>Remove PTS Ads Monitor access from your Google Account and connect again with consent. Google only returns a refresh token when offline access is granted.</p>",
        false,
      );
    }

    const safe = tokens.refresh_token.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return page(
      "Google Drive connected",
      `<p style="color:#a7f3b0">Authorization succeeded.</p><p>Copy the value below and add it to Cloudflare as a <strong>Secret</strong> named <code>GOOGLE_OAUTH_REFRESH_TOKEN</code>.</p><textarea readonly style="width:100%;min-height:130px;background:#080808;color:#fff;border:1px solid #333;border-radius:12px;padding:14px;box-sizing:border-box">${safe}</textarea><p style="color:#999">Do not send this token in chat. After saving it in Cloudflare, redeploy the Worker.</p>`,
    );
  } catch (e) {
    return page("Google OAuth exchange failed", `<pre style="white-space:pre-wrap;color:#ffaaaa">${e instanceof Error ? e.message : String(e)}</pre>`, false);
  }
}
