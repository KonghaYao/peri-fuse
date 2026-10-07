import { describe, expect, it } from "vitest";
import {
  isRemoteDatabaseUrl,
  resolveDatabaseConfig,
  validateDatabaseConfig,
} from "./connection-config";

describe("database connection configuration", () => {
  it("treats unset Compose values as absent and lets blank role settings inherit global values", () => {
    expect(
      resolveDatabaseConfig("metadata", "local.db", {
        TURSO_DATABASE_URL: "",
        TURSO_AUTH_TOKEN: "",
      }),
    ).toEqual({ url: "local.db" });
    expect(
      resolveDatabaseConfig("metadata", "local.db", {
        TURSO_DATABASE_URL: "libsql://cloud.turso.io",
        TURSO_AUTH_TOKEN: "token",
        TURSO_METADATA_DATABASE_URL: " ",
        TURSO_METADATA_AUTH_TOKEN: "",
      }),
    ).toEqual({ url: "libsql://cloud.turso.io", authToken: "token" });
  });
  it("keeps local defaults and legacy paths when remote settings are absent", () => {
    expect(resolveDatabaseConfig("metadata", "local.db", {})).toEqual({ url: "local.db" });
    expect(
      resolveDatabaseConfig("telemetry", "local.db", { LANGFUSE_SQLITE_DB_PATH: "file:custom.db" }),
    ).toEqual({ url: "file:custom.db" });
  });
  it("lets a global remote URL replace legacy local settings for every domain", () => {
    const environment = {
      TURSO_DATABASE_URL: "libsql://cloud.turso.io",
      TURSO_AUTH_TOKEN: "token",
      DATABASE_URL: "file:old.db",
      GATEWAY_DB_URL: "old-gateway.db",
      LANGFUSE_SQLITE_DB_PATH: "old-telemetry.db",
    };
    for (const role of ["metadata", "telemetry", "gateway"] as const)
      expect(resolveDatabaseConfig(role, "local.db", environment)).toEqual({
        url: "libsql://cloud.turso.io",
        authToken: "token",
      });
  });
  it("supports per-domain URL and token overrides, including hybrid local storage", () => {
    const environment = {
      TURSO_DATABASE_URL: "libsql://all.turso.io",
      TURSO_AUTH_TOKEN: "global",
      TURSO_TELEMETRY_DATABASE_URL: "https://telemetry.turso.io",
      TURSO_TELEMETRY_AUTH_TOKEN: "isolated",
      TURSO_GATEWAY_DATABASE_URL: "gateway.db",
    };
    expect(resolveDatabaseConfig("telemetry", "unused", environment)).toEqual({
      url: "https://telemetry.turso.io",
      authToken: "isolated",
    });
    expect(resolveDatabaseConfig("gateway", "unused", environment)).toEqual({ url: "gateway.db" });
  });
  it("passes remote settings through without requiring a token", () => {
    expect(
      resolveDatabaseConfig("metadata", "local.db", {
        TURSO_DATABASE_URL: "libsql://cloud.turso.io",
      }),
    ).toEqual({ url: "libsql://cloud.turso.io" });
    expect(
      validateDatabaseConfig({ url: "http://database:8080/path?region=eu", authToken: " " }),
    ).toEqual({ url: "http://database:8080/path?region=eu" });
  });
  it.each([
    "libsql://cloud.turso.io/tenant/database?region=eu&tag=a%2Fb&tag=c",
    "https://cloud.turso.io/tenant/database/?region=eu&prefix=/",
    "http://127.0.0.1:8080/tenant/database?region=local",
    "http://db.example.com:8080/tenant/database?region=eu&tag=a%2Fb&tag=c",
    "http://192.168.1.10:8080/tenant/database/?prefix=/",
    "http://[fd00::1]:8080/tenant/database?region=local",
  ])("preserves remote paths and query parameters in URL %s", (url) => {
    expect(validateDatabaseConfig({ url: ` ${url} `, authToken: " token " })).toEqual({
      url,
      authToken: "token",
    });
    for (const role of ["metadata", "telemetry", "gateway"] as const) {
      expect(
        resolveDatabaseConfig(role, "local.db", {
          TURSO_DATABASE_URL: url,
          TURSO_AUTH_TOKEN: "token",
        }),
      ).toEqual({ url, authToken: "token" });
      expect(
        resolveDatabaseConfig(role, "local.db", {
          TURSO_DATABASE_URL: "https://cloud.turso.io",
          TURSO_AUTH_TOKEN: "token",
          [`TURSO_${role.toUpperCase()}_DATABASE_URL`]: url,
        }),
      ).toEqual({ url, authToken: "token" });
    }
  });
  it.each([
    "http://user:secret@db.example.com/path",
    "http://db.example.com/path?region=eu#fragment",
    "https://user:secret@cloud.turso.io",
    "https://cloud.turso.io/path?region=eu#fragment",
    "wss://cloud.turso.io",
    "ws://database:8080/path",
    "turso://database/path?region=eu",
    "custom+db://database/path?region=eu",
    "http://",
  ])("leaves URI validation to the database driver for %s", (url) => {
    expect(validateDatabaseConfig({ url, authToken: "token" })).toEqual({
      url,
      authToken: "token",
    });
    expect(isRemoteDatabaseUrl(url)).toBe(true);
  });
  it.each(["local.db", "file:local.db", "file:///tmp/local.db", ":memory:"])(
    "keeps local storage routing for %s",
    (url) => {
      expect(isRemoteDatabaseUrl(url)).toBe(false);
      expect(validateDatabaseConfig({ url, authToken: "ignored" })).toEqual({ url });
    },
  );
  it("leaves empty direct URLs for the database driver to validate", () => {
    expect(validateDatabaseConfig({ url: " " })).toEqual({ url: "" });
  });
});
