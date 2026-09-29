import { NextRequest, NextResponse } from "next/server";

function isPublicApi(pathname: string) {
  if (pathname === "/api/telegram") return true;
  if (pathname.startsWith("/api/monitor")) return true;
  if (pathname.startsWith("/api/reporting/morning")) return true;
  if (pathname.startsWith("/api/reporting/lifecycle")) return true;
  return false;
}

export function middleware(request: NextRequest) {
  if (isPublicApi(request.nextUrl.pathname)) return NextResponse.next();

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
