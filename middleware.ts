import { NextRequest, NextResponse } from "next/server";

function isPublicApi(pathname: string) {
  if (pathname === "/api/telegram") return true;
  if (pathname === "/api/telegram/audit") return true;
  if (pathname === "/api/tasks-bot") return true;
  if (pathname === "/api/tasks-bot/reminders") return true;
  if (pathname.startsWith("/api/monitor")) return true;
  if (pathname.startsWith("/api/reporting/morning")) return true;
  if (pathname.startsWith("/api/reporting/lifecycle")) return true;
  if (pathname.startsWith("/api/performance/check")) return true;
  if (pathname.startsWith("/api/performance/brief")) return true;
  return false;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname === "/api/telegram" && request.method === "POST") {
    try {
      const cloned = request.clone();
      const update = await cloned.json();
      const text = typeof update?.message?.text === "string" ? update.message.text.trim() : "";
      if (/^\/(?:audit_account|performance_account)(?:@\w+)?(?:\s|$)/i.test(text)) {
        const url = request.nextUrl.clone();
        url.pathname = "/api/telegram/audit";
        return NextResponse.rewrite(url);
      }
    } catch {}
  }

  if (isPublicApi(pathname)) return NextResponse.next();

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const separator = decoded.indexOf(":");
      const suppliedPassword = separator >= 0 ? decoded.slice(separator + 1) : "";
      if (suppliedPassword === password) return NextResponse.next();
    } catch {}
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="PTS Ads Monitor"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
