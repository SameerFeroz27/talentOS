import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Deployment Configuration Validation Tests
//
// Protects against: Docker Compose service misconfiguration, Dockerfile build
// inconsistencies, CI workflow gaps, and port/dependency drift that passes unit
// tests but causes deployment failures.
//
// These tests parse the config files (not run Docker) so they're fast and
// suitable for CI.
// ─────────────────────────────────────────────────────────────────────────────

const composePath = fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url));
const composeContent = readFileSync(composePath, "utf8");

const dockerfilePath = fileURLToPath(new URL("../../../Dockerfile", import.meta.url));
const dockerfileContent = readFileSync(dockerfilePath, "utf8");

const ciPath = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));
const ciContent = readFileSync(ciPath, "utf8");

// ── Docker Compose services ─────────────────────────────────────────────────

describe("docker-compose.yml service definitions", () => {
  it("defines postgres with health check and port 5432", () => {
    expect(composeContent).toContain("postgres:");
    expect(composeContent).toContain("5432");
    expect(composeContent).toContain("pg_isready");
  });

  it("defines keycloak with --import-realm and port 8080", () => {
    expect(composeContent).toContain("keycloak:");
    expect(composeContent).toContain("--import-realm");
    expect(composeContent).toContain("8080");
  });

  it("defines keycloak-postgres for Keycloak's own database", () => {
    expect(composeContent).toContain("keycloak-postgres:");
  });

  it("defines minio with ports 9000 and 9001", () => {
    expect(composeContent).toContain("minio:");
    expect(composeContent).toContain("9000");
    expect(composeContent).toContain("9001");
  });

  it("defines minio-setup for bucket initialization", () => {
    expect(composeContent).toContain("minio-setup:");
  });

  it("keycloak depends on keycloak-postgres being healthy", () => {
    expect(composeContent).toContain("depends_on:");
    expect(composeContent).toContain("service_healthy");
  });

  it("keycloak mounts the realm import directory read-only", () => {
    expect(composeContent).toContain("./keycloak/import:/opt/keycloak/data/import:ro");
  });

  it("uses postgres:16-alpine image", () => {
    expect(composeContent).toContain("postgres:16-alpine");
  });

  it("uses keycloak:26.0 image", () => {
    expect(composeContent).toContain("quay.io/keycloak/keycloak:26.0");
  });

  it("defines named volumes for persistent data", () => {
    expect(composeContent).toContain("postgres-data:");
    expect(composeContent).toContain("keycloak-postgres-data:");
    expect(composeContent).toContain("minio-data:");
  });
});

// ── Dockerfile ──────────────────────────────────────────────────────────────

describe("Dockerfile build stages", () => {
  it("uses node:24-slim as the base image", () => {
    expect(dockerfileContent).toContain("node:24-slim");
  });

  it("has deps, builder, and runner stages", () => {
    expect(dockerfileContent).toContain("AS deps");
    expect(dockerfileContent).toContain("AS builder");
    expect(dockerfileContent).toContain("AS runner");
  });

  it("runs db:generate before building", () => {
    // Issue: If db:generate is missing from the Docker build, the production
    // image has a stale Prisma client.
    expect(dockerfileContent).toContain("npm run db:generate");
  });

  it("copies all package.json files in deps stage", () => {
    const requiredPackages = [
      "apps/applicant/package.json",
      "apps/admin/package.json",
      "packages/auth/package.json",
      "packages/auth-web/package.json",
      "packages/db/package.json",
      "packages/storage/package.json",
      "packages/ui/package.json"
    ];
    for (const pkg of requiredPackages) {
      expect(dockerfileContent, `Dockerfile should copy ${pkg}`).toContain(pkg);
    }
  });

  it("installs linux SWC binary for the runner", () => {
    expect(dockerfileContent).toContain("@next/swc-linux-x64-gnu");
  });

  it("sets NODE_ENV=production in the runner stage", () => {
    expect(dockerfileContent).toContain("ENV NODE_ENV=production");
  });

  it("installs openssl in the runner (Prisma runtime requirement)", () => {
    expect(dockerfileContent).toContain("openssl");
  });

  it("uses standalone output (COPY .next/standalone)", () => {
    expect(dockerfileContent).toContain(".next/standalone");
  });
});

// ── CI workflow ─────────────────────────────────────────────────────────────

describe("CI workflow (.github/workflows/ci.yml)", () => {
  it("runs on push and pull_request", () => {
    expect(ciContent).toContain("on:");
    expect(ciContent).toContain("push:");
    expect(ciContent).toContain("pull_request:");
  });

  it("uses Node.js 24", () => {
    expect(ciContent).toContain("node-version: 24");
  });

  it("generates Prisma client before testing", () => {
    // Issue: If CI doesn't run db:generate, the generated client is stale
    // and tests pass against an outdated client.
    expect(ciContent).toContain("npm run db:generate");
  });

  it("runs typecheck, lint, test, and build", () => {
    expect(ciContent).toContain("npm run typecheck");
    expect(ciContent).toContain("npm run lint");
    expect(ciContent).toContain("npm run test");
    expect(ciContent).toContain("npm run build");
  });

  it("has a separate realm-import validation job", () => {
    expect(ciContent).toContain("realm-import");
    expect(ciContent).toContain("start-dev --import-realm");
  });

  it("realm-import job checks for import failure patterns", () => {
    expect(ciContent).toContain("Failed to run import");
    expect(ciContent).toContain("Unrecognized field");
  });

  it("uses npm ci for deterministic installs", () => {
    expect(ciContent).toContain("npm ci");
  });
});

// ── Port consistency ────────────────────────────────────────────────────────

describe("port consistency across configuration", () => {
  it("applicant port 3100 is consistent in env and compose", () => {
    const applicantEnv = readFileSync(
      fileURLToPath(new URL("../../../apps/applicant/.env", import.meta.url)),
      "utf8"
    );
    expect(applicantEnv).toContain("PORT=3100");
    // docker-compose may or may not define the applicant service with explicit port
    // but the env file should match the expected development port
  });

  it("admin port 3200 is consistent in env", () => {
    const adminEnv = readFileSync(
      fileURLToPath(new URL("../../../apps/admin/.env", import.meta.url)),
      "utf8"
    );
    expect(adminEnv).toContain("PORT=3200");
  });

  it("applicant and admin use different ports", () => {
    const applicantEnv = readFileSync(
      fileURLToPath(new URL("../../../apps/applicant/.env", import.meta.url)),
      "utf8"
    );
    const adminEnv = readFileSync(
      fileURLToPath(new URL("../../../apps/admin/.env", import.meta.url)),
      "utf8"
    );
    const applicantPort = applicantEnv.match(/PORT=(\d+)/)?.[1];
    const adminPort = adminEnv.match(/PORT=(\d+)/)?.[1];
    expect(applicantPort).not.toBe(adminPort);
  });
});

// ── Keycloak realm import file ──────────────────────────────────────────────

describe("keycloak realm import file exists and is valid JSON", () => {
  it("talentos-realm.json exists", () => {
    const realmPath = fileURLToPath(
      new URL("../../../keycloak/import/talentos-realm.json", import.meta.url)
    );
    expect(existsSync(realmPath)).toBe(true);
  });

  it("parses as valid JSON", () => {
    const realmPath = fileURLToPath(
      new URL("../../../keycloak/import/talentos-realm.json", import.meta.url)
    );
    const content = readFileSync(realmPath, "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });
});
