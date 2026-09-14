/**
 * One-off codegen helper: transforms the drizzle-kit *introspected* schema
 * (which loses Prisma semantic types and renders DateTime/Boolean/Decimal/BigInt
 * as `numeric`) into a schema with correct Drizzle column modes:
 *   DateTime -> integer({ mode: "timestamp_ms" })  (Prisma SQLite stores ms ints)
 *   Boolean  -> integer({ mode: "boolean" })
 *   BigInt   -> integer({ mode: "bigint" })
 *   Decimal  -> real
 *   Float    -> real
 * It also rewrites `.default(sql`(CURRENT_TIMESTAMP)`)` to `.$defaultFn(() => new Date())`,
 * adds `.$onUpdateFn(() => new Date())` for @updatedAt columns, and restores
 * boolean defaults that introspection dropped.
 *
 * Usage: node scripts/transform-drizzle.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const prismaPath = ROOT + "prisma/schema.sqlite.prisma";
const introspectedPath = ROOT + "drizzle/schema.ts";
const outDir = ROOT + "src/db/schema";

// ── 1. Parse Prisma schema for semantic types ──────────────────────
const SEMANTIC = new Set(["DateTime", "Boolean", "BigInt", "Decimal", "Float"]);
const typeMap = {}; // sqlTable -> { sqlCol -> baseType }
const updatedAtSet = new Set(); // "sqlTable.sqlCol"
const boolDefault = {}; // "sqlTable.sqlCol" -> "true" | "false"

{
  const lines = readFileSync(prismaPath, "utf8").split("\n");
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    let m = line.match(/^model\s+(\w+)\s*\{/);
    if (m) {
      cur = { name: m[1], sqlTable: m[1], fields: {}, updatedAt: [], boolDefs: {} };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("}")) {
      typeMap[cur.sqlTable] = cur.fields;
      for (const col of cur.updatedAt) updatedAtSet.add(`${cur.sqlTable}.${col}`);
      for (const [col, val] of Object.entries(cur.boolDefs)) {
        boolDefault[`${cur.sqlTable}.${col}`] = val;
      }
      cur = null;
      continue;
    }
    m = line.match(/@@map\("([^"]+)"\)/);
    if (m) {
      cur.sqlTable = m[1];
      continue;
    }
    if (line.startsWith("@@") || line.startsWith("//") || line === "") continue;
    m = line.match(/^(\w+)\s+(\w+)(\?)?\s*(.*)$/);
    if (!m) continue;
    const fieldName = m[1];
    const baseType = m[2];
    const modifiers = m[4] || "";
    if (!SEMANTIC.has(baseType)) continue;
    const mapMatch = modifiers.match(/@map\("([^"]+)"\)/);
    const col = mapMatch ? mapMatch[1] : fieldName;
    cur.fields[col] = baseType;
    if (/@updatedAt/.test(modifiers)) cur.updatedAt.push(col);
    const defMatch = modifiers.match(/@default\((true|false)\)/);
    if (baseType === "Boolean" && defMatch) {
      cur.boolDefs[col] = defMatch[1];
    }
  }
}

// ── 2. Transform the introspected schema ───────────────────────────
const schemaLines = readFileSync(introspectedPath, "utf8").split("\n");
const out = [];
let tableSql = null;
const stats = { DateTime: 0, Boolean: 0, BigInt: 0, Decimal: 0, Float: 0 };

const COL_RE = /^(\t)(\w+): (numeric|integer|real|text)(\("([^"]*)"\))?(.*)$/;

for (const line of schemaLines) {
  const tbl = line.match(/sqliteTable\("([^"]+)"/);
  if (tbl) tableSql = tbl[1];

  const m = line.match(COL_RE);
  if (!m || !tableSql) {
    out.push(line);
    continue;
  }
  const prop = m[2];
  const col = m[5] || prop;
  let rest = m[6];
  // `numeric()` / `integer()` with empty parens leave a leading "()" in rest
  rest = rest.replace(/^\(\)/, "");
  const t = typeMap[tableSql]?.[col];
  if (!t || !SEMANTIC.has(t)) {
    out.push(line);
    continue;
  }

  let newType;
  if (t === "DateTime") {
    newType = `integer("${col}", { mode: "timestamp_ms" })`;
    rest = rest.replace(/\.default\(sql`\(CURRENT_TIMESTAMP\)`\)/, ".$defaultFn(() => new Date())");
    if (updatedAtSet.has(`${tableSql}.${col}`)) {
      if (rest.includes(".$defaultFn(() => new Date())")) {
        rest = rest.replace(
          ".$defaultFn(() => new Date())",
          ".$defaultFn(() => new Date()).$onUpdateFn(() => new Date())",
        );
      } else {
        rest = ".$onUpdateFn(() => new Date())" + rest;
      }
    }
    stats.DateTime++;
  } else if (t === "Boolean") {
    newType = `integer("${col}", { mode: "boolean" })`;
    // strip any existing boolean default, then restore the prisma one
    rest = rest.replace(/\.default\((true|false)\)/, "");
    const def = boolDefault[`${tableSql}.${col}`];
    if (def) rest = `.default(${def})` + rest;
    stats.Boolean++;
  } else if (t === "BigInt") {
    // drizzle SQLite integer has no bigint mode; store as INTEGER (number).
    newType = `integer("${col}")`;
    stats.BigInt++;
  } else if (t === "Decimal") {
    newType = `real("${col}")`;
    stats.Decimal++;
  } else if (t === "Float") {
    newType = `real("${col}")`;
    stats.Float++;
  } else {
    out.push(line);
    continue;
  }

  out.push(`\t${prop}: ${newType}${rest}`);
}

let result = out.join("\n");

// ── 3. Fix imports (drop now-unused `numeric` / `sql`) ─────────────
const usesNumeric = /numeric\(/.test(result);
const usesSql = /sql`/.test(result);
result = result.replace(/import \{([^}]*)\} from "drizzle-orm\/sqlite-core"/, (full, names) => {
  const kept = names
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !(s === "numeric" && !usesNumeric))
    .join(", ");
  return `import { ${kept} } from "drizzle-orm/sqlite-core"`;
});
if (!usesSql) {
  result = result.replace(/\n?\s*import \{ sql \} from "drizzle-orm"\n/, "\n");
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + "/schema.ts", result);
console.log("Transform stats:", stats);
console.log("usesNumeric:", usesNumeric, "usesSql:", usesSql);
console.log("Wrote", outDir + "/schema.ts");
