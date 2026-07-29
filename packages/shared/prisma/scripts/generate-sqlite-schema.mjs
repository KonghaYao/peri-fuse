#!/usr/bin/env node
/**
 * Transforms the PostgreSQL Prisma schema into a SQLite-compatible version.
 *
 * Usage: node packages/shared/prisma/scripts/generate-sqlite-schema.mjs
 *
 * Transformations applied:
 * - provider: "postgresql" → "sqlite"
 * - Remove directUrl, shadowDatabaseUrl
 * - Remove previewFeatures that SQLite doesn't support (views, metrics)
 * - Convert enum fields → String with default
 * - Remove enum declarations
 * - Convert String[] → String (JSON serialized)
 * - Convert Json/Json? → String/String?
 * - Remove @db.* annotations
 * - Remove unsupported index types (Gin, etc.)
 * - Remove @@index with `type:` parameter
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "../schema.prisma");
const outputPath = resolve(__dirname, "../schema.sqlite.prisma");

let schema = readFileSync(schemaPath, "utf-8");

// 1. Change provider
schema = schema.replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"');

// 2. Remove directUrl and shadowDatabaseUrl
schema = schema.replace(/\s*directUrl\s*=\s*env\("DIRECT_URL"\)\n/, "\n");
schema = schema.replace(/\s*shadowDatabaseUrl\s*=\s*env\("SHADOW_DATABASE_URL"\)\n/, "\n");

// 3. Fix previewFeatures - remove "views" and "metrics" (not supported in SQLite)
schema = schema.replace(/previewFeatures\s*=\s*\[.*?\]/, 'previewFeatures = ["relationJoins"]');

// 4. Collect all enum names and their first values
const enumRegex = /enum\s+(\w+)\s*\{([^}]+)\}/g;
const enums = new Map();
let match;
// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
while ((match = enumRegex.exec(schema)) !== null) {
  const enumName = match[1];
  const values = match[2]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"));
  const firstValue = values[0] || "UNKNOWN";
  enums.set(enumName, firstValue);
}

// 5. Remove enum declarations
schema = schema.replace(/enum\s+\w+\s*\{[^}]+\}\n?/g, "");

// 6. Replace enum type references in model fields with String
for (const [enumName] of enums) {
  // Match field declarations using this enum type (more conservative regex)
  const fieldRegex = new RegExp(`(\\s+\\w+\\s+)${enumName}(\\??)(\\s+)`, "g");
  schema = schema.replace(fieldRegex, (_match, prefix, optional, suffix) => {
    return `${prefix}String${optional}${suffix}`;
  });
}

// 6b. Fix enum @default values - add quotes around unquoted enum values
// e.g., @default(PENDING) -> @default("PENDING")
// Generic fix: quote any @default(WORD) where WORD is all uppercase (likely an enum value)
schema = schema.replace(/@default\(([A-Z][A-Z0-9_]+)\)/g, '@default("$1")');

// 7. Convert primitive array types to String (JSON serialized)
// Only convert primitive arrays, NOT relation arrays (like Project[], User[] etc.)
const primitiveTypes = [
  "String",
  "Int",
  "Boolean",
  "Float",
  "Decimal",
  "DateTime",
  "BigInt",
  "Bytes",
];
for (const ptype of primitiveTypes) {
  const arrRegex = new RegExp(`${ptype}\\[\\]\\s+@default\\([^)]+\\)`, "g");
  schema = schema.replace(arrRegex, 'String @default("[]")');
  const arrRegex2 = new RegExp(`${ptype}\\[\\]`, "g");
  schema = schema.replace(arrRegex2, "String");
}
// Fix single-quoted defaults to double-quoted
schema = schema.replace(/@default\('([^']*)'\)/g, '@default("$1")');

// 8. Convert Json types to String
schema = schema.replace(/Json\?\s+@db\.JsonB/g, "String?");
schema = schema.replace(/Json\s+@db\.JsonB/g, "String");
schema = schema.replace(/Json\?/g, "String?");
schema = schema.replace(/Json\s+@default\("(\{.*?\})"\)/g, 'String @default("$1")');
schema = schema.replace(/(\s+\w+\s+)Json(\s)/g, "$1String$2");
// Catch any remaining standalone Json types
schema = schema.replace(/\bJson\b/g, "String");

// 9. Remove @db.* annotations
schema = schema.replace(/\s*@db\.\w+(\([^)]*\))?/g, "");

// 10. Remove index type specifications (Gin, GiST, etc.)
schema = schema.replace(/,\s*type:\s*\w+/g, "");

// 11. Remove @@index lines with unsupported features
schema = schema.replace(/.*@@index.*type:.*\n/g, "");

// 12. Clean up multiple blank lines
schema = schema.replace(/\n{3,}/g, "\n\n");

// 13. Add header comment
const header = `// AUTO-GENERATED: SQLite-compatible Prisma schema
// Generated from schema.prisma by scripts/generate-sqlite-schema.mjs
// Do NOT edit manually. Run: pnpm run db:generate:sqlite
//
// Differences from PostgreSQL schema:
// - Enums → String fields with @default
// - String[] → String (JSON array, application-layer parse/stringify)
// - Json → String (JSON text, use SQLite JSON1 for queries)
// - No views, no full-text search indexes
//

`;

schema = header + schema;

writeFileSync(outputPath, schema, "utf-8");
console.log(`✅ SQLite schema generated: ${outputPath}`);
console.log(`   Enums converted: ${enums.size}`);
console.log(`   Run: npx prisma generate --schema=prisma/schema.sqlite.prisma`);
