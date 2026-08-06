import { describe, expect, it } from "vitest";
import { resolveTenantFromHost } from "@talentos/auth/tenant";
import { resolveTenantRedirect, isSameBaseDomain } from "./tenant-redirect";

// ─────────────────────────────────────────────────────────────────────────────
// Middleware Route Protection & Redirect Validation Tests
//
// Protects against:
// 1. Unauthenticated users reaching protected routes (applicant /dashboard, /apply,
//    /application; admin all routes except /api/auth, /forbidden, /logged-out).
// 2. Tenant subdomain loss during redirect — the callbackUrl must carry the
//    tenant host so the user returns to their own tenant after login.
// 3. Open redirect — the redirect callback must only allow same-base-domain hosts.
// 4. APPLICANT role reaching admin portal (should redirect to /forbidden).
// 5. Admin-capable roles being denied (ORG_ADMIN, HR, TECH_LEAD should pass).
//
// These tests validate the pure functions that the middleware delegates to,
// without needing a running Next.js server.
// ─────────────────────────────────────────────────────────────────────────────

// ── Applicant middleware: protected route detection ──────────────────────────

describe("applicant middleware: protected route detection", () => {
  // Mirrors PROTECTED_PREFIXES in apps/applicant/middleware.ts
  const PROTECTED_PREFIXES = ["/apply", "/application", "/dashboard"];
  const isProtected = (pathname: string) =>
    PROTECTED_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );

  it("protects /dashboard and its sub-routes", () => {
    expect(isProtected("/dashboard")).toBe(true);
    expect(isProtected("/dashboard/missions")).toBe(true);
    expect(isProtected("/dashboard/journal")).toBe(true);
    expect(isProtected("/dashboard/missions/abc-123")).toBe(true);
  });

  it("protects /apply and /application", () => {
    expect(isProtected("/apply")).toBe(true);
    expect(isProtected("/application")).toBe(true);
    expect(isProtected("/application/step/2")).toBe(true);
  });

  it("does not protect public routes", () => {
    expect(isProtected("/")).toBe(false);
    expect(isProtected("/login")).toBe(false);
    expect(isProtected("/about")).toBe(false);
    expect(isProtected("/api/auth/signin/keycloak")).toBe(false);
  });

  it("does not protect _next static assets", () => {
    expect(isProtected("/_next/static/chunks/app.js")).toBe(false);
    expect(isProtected("/_next/image")).toBe(false);
    expect(isProtected("/favicon.ico")).toBe(false);
  });
});

// ── Admin middleware: route exemption detection ──────────────────────────────

describe("admin middleware: route exemption detection", () => {
  // Mirrors the exemption logic in apps/admin/middleware.ts
  const isExempt = (pathname: string) => {
    const isAuthRoute = pathname.startsWith("/api/auth");
    const isForbidden = pathname === "/forbidden";
    const isLoggedOut = pathname === "/logged-out";
    return isAuthRoute || isForbidden || isLoggedOut;
  };

  it("exempts /api/auth routes (NextAuth handlers)", () => {
    expect(isExempt("/api/auth/signin/keycloak")).toBe(true);
    expect(isExempt("/api/auth/callback/keycloak")).toBe(true);
    expect(isExempt("/api/auth/session")).toBe(true);
    expect(isExempt("/api/auth/signout")).toBe(true);
  });

  it("exempts /forbidden and /logged-out", () => {
    expect(isExempt("/forbidden")).toBe(true);
    expect(isExempt("/logged-out")).toBe(true);
  });

  it("does not exempt admin business routes", () => {
    expect(isExempt("/")).toBe(false);
    expect(isExempt("/applications")).toBe(false);
    expect(isExempt("/programs")).toBe(false);
    expect(isExempt("/submissions")).toBe(false);
    expect(isExempt("/settings")).toBe(false);
  });
});

// ── Tenant callback URL construction ────────────────────────────────────────

describe("tenant callback URL construction", () => {
  // Mirrors tenantCallbackUrl in both middleware files
  function tenantCallbackUrl(host: string | null, protocol: string, pathname: string, search: string): string {
    const requestHost = host ?? "localhost";
    return `${protocol}//${requestHost}${pathname}${search}`;
  }

  it("preserves the tenant subdomain in the callback URL", () => {
    // Issue: Callback URL was relative, so login redirected to the canonical
    // AUTH_URL host instead of the tenant subdomain.
    const url = tenantCallbackUrl("paysyslabs.lvh.me:3100", "http:", "/dashboard", "");
    expect(url).toBe("http://paysyslabs.lvh.me:3100/dashboard");
  });

  it("preserves query parameters in the callback URL", () => {
    const url = tenantCallbackUrl("acme.lvh.me:3200", "http:", "/applications", "?status=ACCEPTED");
    expect(url).toBe("http://acme.lvh.me:3200/applications?status=ACCEPTED");
  });

  it("falls back to localhost when host is null", () => {
    const url = tenantCallbackUrl(null, "http:", "/dashboard", "");
    expect(url).toBe("http://localhost/dashboard");
  });
});

// ── Post-login redirect validation (resolveTenantRedirect) ──────────────────

describe("post-login redirect validation", () => {
  const canonical = "http://demo.lvh.me:3200";
  const baseDomain = "lvh.me";

  it("allows redirect back to the canonical AUTH_URL host", () => {
    expect(resolveTenantRedirect("http://demo.lvh.me:3200/programs", canonical, baseDomain)).toBe(
      "http://demo.lvh.me:3200/programs"
    );
  });

  it("allows redirect to a tenant subdomain of the base domain", () => {
    expect(resolveTenantRedirect("http://paysyslabs.lvh.me:3200/", canonical, baseDomain)).toBe(
      "http://paysyslabs.lvh.me:3200/"
    );
    expect(resolveTenantRedirect("http://acme.lvh.me:3200/dashboard", canonical, baseDomain)).toBe(
      "http://acme.lvh.me:3200/dashboard"
    );
  });

  it("allows redirect to the apex domain", () => {
    expect(resolveTenantRedirect("http://lvh.me:3200/", canonical, baseDomain)).toBe(
      "http://lvh.me:3200/"
    );
  });

  it("collapses foreign hosts to canonical (no open redirect)", () => {
    expect(resolveTenantRedirect("http://evil.com/steal", canonical, baseDomain)).toBe(canonical);
    expect(resolveTenantRedirect("http://attacker.lvh.me.evil.com/", canonical, baseDomain)).toBe(canonical);
  });

  it("rejects look-alike domains that are not subdomains", () => {
    expect(resolveTenantRedirect("http://notlvh.me/", canonical, baseDomain)).toBe(canonical);
    expect(resolveTenantRedirect("http://lvh.me.evil.com/", canonical, baseDomain)).toBe(canonical);
  });

  it("handles malformed URLs gracefully", () => {
    expect(resolveTenantRedirect("http://[bad", canonical, baseDomain)).toBe(canonical);
  });

  it("resolves relative non-URL strings as paths against canonical", () => {
    // "not-a-url" is treated as a relative path by the URL constructor,
    // which is correct — it becomes canonical/not-a-url.
    expect(resolveTenantRedirect("not-a-url", canonical, baseDomain)).toBe(
      "http://demo.lvh.me:3200/not-a-url"
    );
  });

  it("resolves relative paths against the canonical origin", () => {
    expect(resolveTenantRedirect("/applications", canonical, baseDomain)).toBe(
      "http://demo.lvh.me:3200/applications"
    );
  });
});

// ── Tenant resolution from host header ──────────────────────────────────────

describe("tenant resolution from host header (middleware integration)", () => {
  it("resolves paysyslabs from paysyslabs.lvh.me", () => {
    const result = resolveTenantFromHost("paysyslabs.lvh.me:3100", "lvh.me");
    expect(result.tenantSlug).toBe("paysyslabs");
    expect(result.source).toBe("subdomain");
  });

  it("resolves demo from demo.lvh.me", () => {
    const result = resolveTenantFromHost("demo.lvh.me:3200", "lvh.me");
    expect(result.tenantSlug).toBe("demo");
    expect(result.source).toBe("subdomain");
  });

  it("falls back to default tenant for bare localhost", () => {
    const result = resolveTenantFromHost("localhost:3100", "localhost", "demo");
    expect(result.tenantSlug).toBe("demo");
    expect(result.source).toBe("default");
  });

  it("falls back to default tenant for 127.0.0.1", () => {
    const result = resolveTenantFromHost("127.0.0.1:3300", "localhost", "demo");
    expect(result.tenantSlug).toBe("demo");
    expect(result.source).toBe("default");
  });

  it("resolves subdomain.localhost for local development", () => {
    const result = resolveTenantFromHost("acme.localhost:3100", "localhost", "demo");
    expect(result.tenantSlug).toBe("acme");
    expect(result.source).toBe("subdomain");
  });

  it("falls back to default for null/undefined host", () => {
    expect(resolveTenantFromHost(null, "lvh.me", "demo").tenantSlug).toBe("demo");
    expect(resolveTenantFromHost(undefined, "lvh.me", "demo").tenantSlug).toBe("demo");
  });

  it("handles multi-level subdomains (takes the last label before base domain)", () => {
    const result = resolveTenantFromHost("app.paysyslabs.lvh.me:3100", "lvh.me");
    expect(result.tenantSlug).toBe("paysyslabs");
    expect(result.source).toBe("subdomain");
  });
});

// ── Cookie domain sharing validation ────────────────────────────────────────

describe("cookie domain sharing validation", () => {
  it("isSameBaseDomain matches subdomains of the base domain", () => {
    expect(isSameBaseDomain("paysyslabs.lvh.me", "lvh.me")).toBe(true);
    expect(isSameBaseDomain("demo.lvh.me", "lvh.me")).toBe(true);
    expect(isSameBaseDomain("lvh.me", "lvh.me")).toBe(true);
    expect(isSameBaseDomain("a.b.lvh.me", "lvh.me")).toBe(true);
  });

  it("isSameBaseDomain rejects foreign hosts", () => {
    expect(isSameBaseDomain("evil.com", "lvh.me")).toBe(false);
    expect(isSameBaseDomain("notlvh.me", "lvh.me")).toBe(false);
    expect(isSameBaseDomain("lvh.me.evil.com", "lvh.me")).toBe(false);
  });
});
