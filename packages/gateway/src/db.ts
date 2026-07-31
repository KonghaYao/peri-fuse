/**
 * Prisma client singleton for PeriGateway.
 */
import { PrismaClient } from "./generated/prisma/index.js";

let _prisma: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.GATEWAY_DB_URL,
        },
      },
    });
  }
  return _prisma;
}

export type Db = PrismaClient;
