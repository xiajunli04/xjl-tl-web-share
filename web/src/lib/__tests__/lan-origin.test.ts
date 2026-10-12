import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("LAN same-origin requests", () => {
  it("builds API and WebSocket URLs using the page origin when the API base is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    vi.stubGlobal("window", { location: { origin: "http://192.168.66.121:3001" } });
    vi.resetModules();
    const { buildUrl } = await import("../http");
    const { interpretWsUrl } = await import("../api/interpret");
    expect(buildUrl("/api/auth/login")).toBe("http://192.168.66.121:3001/api/auth/login");
    expect(buildUrl("/api/history", { page: 2, keyword: "雨", absent: null })).toBe(
      "http://192.168.66.121:3001/api/history?page=2&keyword=%E9%9B%A8",
    );
    expect(interpretWsUrl("a+b")).toBe("ws://192.168.66.121:3001/ws/interpret?ticket=a%2Bb");
  });

  it("preserves an explicitly configured backend address", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.com/");
    vi.resetModules();
    const { buildUrl } = await import("../http");
    expect(buildUrl("/api/auth/login")).toBe("https://api.example.com/api/auth/login");
  });

  it("removes the browser origin only for same-origin proxied calls", () => {
    vi.stubEnv("API_PROXY_TARGET", "http://localhost:18080");
    const request = new NextRequest("http://192.168.66.121:3001/api/auth/login", {
      headers: { host: "192.168.66.121:3001", origin: "http://192.168.66.121:3001", authorization: "Bearer test" },
    });
    const response = proxy(request);
    expect(response.headers.get("x-middleware-override-headers")).not.toContain("origin");
    expect(response.headers.get("x-middleware-request-authorization")).toBe("Bearer test");
  });

  it.each(["https://foreign.example", "https://192.168.66.121:3001", "null"])(
    "keeps foreign origin %s subject to backend CORS", (origin) => {
      vi.stubEnv("API_PROXY_TARGET", "http://localhost:18080");
      const request = new NextRequest("http://192.168.66.121:3001/api/auth/login", {
        headers: { host: "192.168.66.121:3001", origin },
      });
      expect(proxy(request).headers.has("x-middleware-override-headers")).toBe(false);
    },
  );
});
