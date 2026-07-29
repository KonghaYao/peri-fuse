/**
 * Shared helpers for lite-server integration tests.
 *
 * Tests exercise the Hono app in-process via `app.request()` (no port
 * binding) against the throwaway SQLite databases prepared by
 * `global-setup.ts`.
 */
import type { Hono } from "hono";
import { createApp } from "../app";
import type { LiteServerEnv } from "../auth";
import { TEST_PUBLIC_KEY, TEST_SECRET_KEY } from "./test-db-paths";

let app: Hono<LiteServerEnv> | null = null;

/** Lazily create (and cache) the app under test. */
export function getApp(): Hono<LiteServerEnv> {
  if (!app) app = createApp();
  return app;
}

export function basicAuth(
  publicKey: string = TEST_PUBLIC_KEY,
  secretKey: string = TEST_SECRET_KEY,
): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export async function apiGet<T = any>(
  path: string,
  auth: string | null = basicAuth(),
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = auth;
  const res = await getApp().request(path, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function apiPost<T = any>(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  auth: string = basicAuth(),
): Promise<ApiResult<T>> {
  const isBinary = body instanceof Uint8Array;
  const res = await getApp().request(path, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": isBinary ? "application/x-protobuf" : "application/json",
      ...extraHeaders,
    },
    body: (isBinary ? body : JSON.stringify(body)) as BodyInit,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
