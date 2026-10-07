import { describe, expect, it } from "vitest";
import { resolveDatabaseConfig, validateDatabaseConfig } from "./connection-config";
import { createLocalDatabase } from "./local";

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
  it("fails closed without a token and never interprets remote URLs as file paths", () => {
    expect(() =>
      resolveDatabaseConfig("metadata", "local.db", {
        TURSO_DATABASE_URL: "libsql://cloud.turso.io",
      }),
    ).toThrow("auth token is required");
    expect(() => createLocalDatabase("https://cloud.turso.io")).toThrow("auth token is required");
  });
  it.each([
    "http://cloud.turso.io",
    "https://user:secret@cloud.turso.io",
    "https://cloud.turso.io?token=secret",
    "https://cloud.turso.io/path",
    "wss://cloud.turso.io",
  ])("rejects unsafe or unsupported URL %s", (url) => {
    expect(() => validateDatabaseConfig({ url, authToken: "token" })).toThrow();
  });
});
