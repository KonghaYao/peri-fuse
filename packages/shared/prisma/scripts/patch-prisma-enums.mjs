/**
 * patch-prisma-enums.mjs
 *
 * After generating Prisma Client from the SQLite schema (which has no enums),
 * this script patches the generated client to re-export all enum values from
 * the PostgreSQL schema. This allows code that imports enums from @prisma/client
 * to work at runtime in lite mode.
 *
 * Usage: node packages/shared/prisma/scripts/patch-prisma-enums.mjs
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "schema.prisma");

// 1. Parse enums from PostgreSQL schema
const schema = readFileSync(schemaPath, "utf8");
const enumRegex = /^enum\s+(\w+)\s*\{([^}]+)\}/gm;
const enums = {};
let m;
// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
while ((m = enumRegex.exec(schema)) !== null) {
  const name = m[1];
  const values = m[2]
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
    .map((l) => l.replace(/\s+@map\([^)]*\)/, "").trim()) // strip @map annotations
    .filter((l) => l); // remove empty after strip
  enums[name] = values;
}

console.log(`Found ${Object.keys(enums).length} enums in PostgreSQL schema`);

// 2. Find the generated Prisma Client directory
const rootDir = resolve(__dirname, "..", "..", "..", "..");
const nodeModulesDir = join(rootDir, "node_modules");

// In pnpm, the client is in .pnpm store
let clientDir = null;
const pnpmDir = join(nodeModulesDir, ".pnpm");
if (existsSync(pnpmDir)) {
  const dirs = readdirSync(pnpmDir).filter((d) => d.startsWith("@prisma+client@"));
  for (const dir of dirs) {
    const candidate = join(pnpmDir, dir, "node_modules", ".prisma", "client");
    if (existsSync(join(candidate, "index.js"))) {
      clientDir = candidate;
      break;
    }
  }
}

// Fallback: standard location
if (!clientDir) {
  const standard = join(nodeModulesDir, ".prisma", "client");
  if (existsSync(join(standard, "index.js"))) {
    clientDir = standard;
  }
}

if (!clientDir) {
  console.error("ERROR: Could not find generated Prisma Client directory");
  process.exit(1);
}

console.log(`Patching Prisma Client at: ${clientDir}`);

// 3. Generate the enum JS code
function generateEnumJs() {
  let code = "\n// === PATCHED: Enums from PostgreSQL schema (for lite mode compatibility) ===\n";
  for (const [name, values] of Object.entries(enums)) {
    const obj = values.map((v) => `  ${v}: '${v}'`).join(",\n");
    code += `exports.${name} = exports.$Enums.${name} = {\n${obj}\n};\n`;
    code += `Prisma.${name} = exports.${name};\n`;
  }
  code += "// === END PATCHED ENUMS ===\n";
  return code;
}

// 4. Generate the enum TS declarations
function generateEnumDts() {
  let code = "\n// === PATCHED: Enums from PostgreSQL schema (for lite mode compatibility) ===\n";
  for (const [name, values] of Object.entries(enums)) {
    code += `export declare const ${name}: {\n`;
    for (const v of values) {
      code += `  readonly ${v}: "${v}",\n`;
    }
    code += `};\n`;
    code += `export type ${name} = (typeof ${name})[keyof typeof ${name}];\n`;
  }
  code += "// === END PATCHED ENUMS ===\n";
  return code;
}

// 5. Patch index.js
const indexPath = join(clientDir, "index.js");
let indexContent = readFileSync(indexPath, "utf8");

// Remove previous patch if exists
indexContent = indexContent.replace(
  /\n\/\/ === PATCHED: Enums from PostgreSQL schema[\s\S]*?\/\/ === END PATCHED ENUMS ===\n/g,
  "",
);

// Find the line "exports.$Enums = {}" and insert after it
const enumMarker = "exports.$Enums = {}";
if (indexContent.includes(enumMarker)) {
  // Replace empty $Enums with populated one
  const enumJs = generateEnumJs();
  indexContent = indexContent.replace(enumMarker, enumMarker + enumJs);
  writeFileSync(indexPath, indexContent, "utf8");
  console.log("✓ Patched index.js");
} else if (indexContent.includes("// === PATCHED: Enums")) {
  console.log("✓ index.js already patched");
} else {
  // Append at end as fallback
  indexContent += generateEnumJs();
  writeFileSync(indexPath, indexContent, "utf8");
  console.log("✓ Patched index.js (appended)");
}

// 6. Patch index.d.ts
const dtsPath = join(clientDir, "index.d.ts");
if (existsSync(dtsPath)) {
  let dtsContent = readFileSync(dtsPath, "utf8");

  // Remove previous patch if exists
  dtsContent = dtsContent.replace(
    /\n\/\/ === PATCHED: Enums from PostgreSQL schema[\s\S]*?\/\/ === END PATCHED ENUMS ===\n/g,
    "",
  );

  if (!dtsContent.includes("// === PATCHED: Enums")) {
    dtsContent += generateEnumDts();
    writeFileSync(dtsPath, dtsContent, "utf8");
    console.log("✓ Patched index.d.ts");
  }
}

// 7. Patch index-browser.js (used by Turbopack/webpack for browser bundles)
const browserJsPath = join(clientDir, "index-browser.js");
if (existsSync(browserJsPath)) {
  let browserContent = readFileSync(browserJsPath, "utf8");
  // Remove previous patch if exists
  browserContent = browserContent.replace(
    /\n\/\/ === PATCHED: Enums from PostgreSQL schema[\s\S]*?\/\/ === END PATCHED ENUMS ===\n/g,
    "",
  );
  // Generate browser-compatible enum code (no $Enums namespace)
  let browserEnumCode =
    "\n// === PATCHED: Enums from PostgreSQL schema (for lite mode compatibility) ===\n";
  for (const [name, values] of Object.entries(enums)) {
    const obj = values.map((v) => `  ${v}: '${v}'`).join(",\n");
    browserEnumCode += `Prisma.${name} = {\n${obj}\n};\n`;
  }
  browserEnumCode += "// === END PATCHED ENUMS ===\n";
  // Insert before Object.assign(exports, Prisma) so enums get exported
  const assignMarker = "Object.assign(exports, Prisma)";
  if (browserContent.includes(assignMarker)) {
    browserContent = browserContent.replace(assignMarker, `${browserEnumCode}\n${assignMarker}`);
  } else {
    browserContent += browserEnumCode;
  }
  writeFileSync(browserJsPath, browserContent, "utf8");
  console.log("✓ Patched index-browser.js");
}

// 8. Also patch default.js and default.d.ts if they re-export from index
const defaultJsPath = join(clientDir, "default.js");
if (existsSync(defaultJsPath)) {
  const defaultJs = readFileSync(defaultJsPath, "utf8");
  if (!defaultJs.includes("// === PATCHED: Enums")) {
    // default.js typically does module.exports = { ...require('./index.js') }
    // The enums should already be re-exported through index.js
    console.log("✓ default.js uses index.js re-export (no patch needed)");
  }
}

console.log("\n✅ Prisma Client enum patch complete!");
console.log(`   ${Object.keys(enums).length} enums injected: ${Object.keys(enums).join(", ")}`);
