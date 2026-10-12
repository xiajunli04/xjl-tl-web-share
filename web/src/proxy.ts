import { NextResponse, type NextRequest } from "next/server";

/** Same-origin browser requests become server-to-server calls to the configured backend. */
export function proxy(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!process.env.API_PROXY_TARGET || !origin) return NextResponse.next();

  try {
    // Keep foreign origins intact so backend CORS still rejects cross-site requests.
    if (new URL(origin).origin !== `${request.nextUrl.protocol}//${request.headers.get("host")}`) return NextResponse.next();
  } catch {
    return NextResponse.next();
  }

  const headers = new Headers(request.headers);
  headers.delete("origin");
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/api/:path*", "/ws/:path*"] };
