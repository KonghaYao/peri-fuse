import crypto from "node:crypto";
import { expect, it } from "vitest";
import {
  IO_MESSAGE_HASH_DOMAIN,
  JSON_SLICE_DEFAULT_LIMITS,
  type JsonSliceLimits,
  type JsonSlicePlan,
  planJsonSlices,
} from "./json-slices";

/** 冻结清单：降级枚举（独立书写，防止枚举被改名或删除）。 */
const FROZEN_REASONS =
  "input-too-large input-too-small not-json unsupported-shape duplicate-messages-key too-many-elements too-deep no-candidate refs-below-ratio token-budget-exceeded manifest-too-large manifest-not-smaller".split(
    " ",
  );

/** §5.1 域前缀的独立字面量，用于钉住实现常量与 hash 值。 */
const HASH_DOMAIN = "peri-fuse:io-message:v1\0";

/** 只放宽尺寸阈值，保留 minElementBytes 与 manifest 判定。 */
const SHAPE_ONLY: Partial<JsonSliceLimits> = {
  minInputBytes: 1,
  minElementBytes: 1,
  minRefRatio: 0,
  requireManifestSmaller: false,
};

function utf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

function hashBytes(source: Buffer, start: number, end: number): Buffer {
  const digest = crypto.createHash("sha256");
  return digest.update(HASH_DOMAIN).update(source.subarray(start, end)).digest();
}

/** 按区间取原文；用于断言字节留在 LITERAL 还是进入 REF。 */
function textOf(plan: JsonSlicePlan, ranges: readonly { start: number; end: number }[]): string {
  const slice = (range: { start: number; end: number }) =>
    Buffer.from(plan.bytes.subarray(range.start, range.end)).toString("utf8");
  return ranges.map(slice).join("|");
}

/** 按冻结顺序独立拼回原文并校验计划不变量；返回失败原因或 null。 */
function verifyPlan(input: string, plan: JsonSlicePlan): string | null {
  const source = utf8(input);
  const hex = (hash: Uint8Array) => Buffer.from(hash).toString("hex");
  if (!Buffer.from(plan.bytes).equals(source)) return "plan.bytes != 输入 UTF-8";
  if (plan.literals.length !== plan.refs.length + 1) return "literal/ref 非严格交替";
  const parts: Buffer[] = [];
  let cursor = 0;
  for (let index = 0; index < plan.refs.length; index++) {
    const literal = plan.literals[index];
    const ref = plan.refs[index];
    if (literal.start !== cursor || literal.end <= literal.start) return `literal[${index}] 非法`;
    if (ref.start !== literal.end || ref.end <= ref.start) return `ref[${index}] 非法`;
    if (!Buffer.from(ref.hash).equals(hashBytes(source, ref.start, ref.end))) {
      return `refs[${index}].hash != §5.1 域 hash`;
    }
    parts.push(source.subarray(literal.start, literal.end), source.subarray(ref.start, ref.end));
    cursor = ref.end;
  }
  const tail = plan.literals[plan.refs.length];
  if (tail.start !== cursor || tail.end !== source.length) return "尾部 LITERAL 未覆盖末尾";
  parts.push(source.subarray(tail.start, tail.end));
  if (!Buffer.concat(parts).equals(source)) return "拼接重组 != 原始字节";
  let manifest = 74 + 4 + plan.refs.length * 33;
  for (const literal of plan.literals) manifest += 5 + (literal.end - literal.start);
  if (plan.manifestBytes !== manifest) return `manifestBytes 不符：${plan.manifestBytes}`;
  const unique = new Set(plan.hashes.map(hex));
  const order = [...new Set(plan.refs.map((ref) => hex(ref.hash)))];
  if (unique.size !== plan.hashes.length) return "hashes 未去重";
  if (order.join() !== plan.hashes.map(hex).join()) return "hashes 顺序不是首次出现顺序";
  for (const ref of plan.refs) if (!unique.has(hex(ref.hash))) return "ref hash 不在 hashes 中";
  return null;
}

/** 期望 ok，并完成全部不变量与逐字节往返校验。 */
function plan(input: string, limits: Partial<JsonSliceLimits> = {}): JsonSlicePlan {
  const result = planJsonSlices(input, limits);
  if (result.status !== "ok") throw new Error(`预期 ok，实际降级：${result.reason}`);
  const problem = verifyPlan(input, result.plan);
  if (problem) throw new Error(problem);
  return result.plan;
}

/** 期望明确降级，且结果不含任何半截计划。 */
function expectDegrade(input: string, reason: string, limits: Partial<JsonSliceLimits> = {}) {
  const result = planJsonSlices(input, limits);
  expect(result.status, `预期 ${reason}`).toBe("degrade");
  if (result.status === "degrade") expect(result.reason).toBe(reason);
  expect("plan" in result).toBe(false);
}

function element(index: number, size = 400): string {
  return `{"role":"user","content":"m${index}-${"a".repeat(size)}"}`;
}

/** 代表性元素：转义、CRLF、Unicode（含代理对）、大整数、指数、嵌套容器、标量。 */
const CONTENTS = [
  '{"role":"assistant","content":"line1\\nline2\\t\\"q\\"\\\\"}',
  '{"role":"user","content":"emoji 😀 🚀 中文 \\u4e2d\\u6587"}',
  '{"role":"tool","content":"\\ud83d\\ude00 surrogate pair \\u0000"}',
  '{"role":"assistant","content":[{"type":"text","text":"hi"}]}',
  '{"usage":{"input":123456789012345678901234567890,"output":-1.25e-30}}',
  '{"nested":{"a":[[[{"b":[1,2,3,"x","\\u00e9"]}]]]}}',
  '{"role":"user","content":"slash \\/ and CRLF\\r\\n"}',
  '"plain string element with \\t tab"',
  '[1,2,3,{"deep":"value"}]',
  "123456789012345678901234567890",
  "-1.25E+300",
];
const CONTENT_LABELS = "escape+crlf+unicode+surrogate+bigint+exponent";

/** 把元素原文撑到 ≥256B；标量元素刻意不撑大（留在 LITERAL）。 */
function padElement(source: string, size: number): string {
  const fill = `"${"p".repeat(size)}"`;
  if (source.startsWith("{")) return `{"_pad":${fill},${source.slice(1)}`;
  if (source === "[]") return `[${fill}]`;
  if (source.startsWith("[")) return `${source.slice(0, -1)},${fill}]`;
  if (source.startsWith('"')) return `"${source.slice(1, -1)}${"p".repeat(size)}"`;
  return source;
}

function contentMessages(count: number, size: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    padElement(CONTENTS[index % CONTENTS.length], size + ((index * 7) % 40)),
  );
}

interface BuildOptions {
  key?: string;
  separator?: string;
  head?: string;
  tail?: string;
  topLevelArray?: boolean;
}

function build(messages: string[], options: BuildOptions = {}): string {
  const separator = options.separator ?? ",";
  if (options.topLevelArray) return `[${messages.join(separator)}]`;
  const head = options.head ?? `{"model":"gpt-4o","${options.key ?? "messages"}":`;
  return `${head}[${messages.join(separator)}]${options.tail ?? ',"stream":true}'}`;
}

function refSize(messages: string[]): number {
  return messages.reduce((sum, message) => sum + utf8(message).length, 0);
}

/** 期望成为 REF 的元素数：只有 ≥256B 的元素被切走。 */
function expectedRefs(messages: string[]): number {
  return messages.filter((message) => utf8(message).length >= 256).length;
}

/** 用 pad 字段把 input 精确调到 target 字节数（refBytes 为 REF 覆盖字节数）。 */
function padTo(input: string, refBytes: number, target: number): string {
  const literal = utf8(input).length - refBytes;
  return input.replace('"pad":""', `"pad":"${"z".repeat(target - refBytes - literal)}"`);
}

/** 顶层值之后追加合法空白，把 input 抬到默认阈值之上。 */
function padText(text: string): string {
  return `${text}${" ".repeat(17 * 1024)}`;
}

const HEAVY = build(contentMessages(45, 380));
const SMALL_ARRAY = build(["1", "2", "3", "4"], { topLevelArray: true });
const DUPLICATE_KEY = build([element(1)], { head: '{"messages":[],"messages":' });
const DUPLICATE_ESCAPED_KEY = build([element(1)], { head: '{"messag\\u0065s":[],"messages":' });
const BELOW_RATIO = build([element(1, 300)], { tail: `,"p":"${"z".repeat(4000)}"}` });
/** 元素数与 token 预算用例的输入：元素多且总长超过 16KiB。 */
const BUDGET_INPUT = build(contentMessages(70, 300));
const EDGE = Array.from({ length: 25 }, (_, index) => element(index, 400));
const EDGE_BASE = build(EDGE, { head: '{"pad":"","messages":' });
const EDGE_REFS = refSize(EDGE);
const MANY = build(
  Array.from({ length: 10_000 }, (_, index) => `"e${index}"`),
  { topLevelArray: true },
);

it("顶层对象/顶层数组都能切分，转义同名属性名同样识别", () => {
  const messages = contentMessages(45, 380);
  const refs = expectedRefs(messages);
  for (const key of ["messages", "\\u006dessages", "messag\\u0065s", "mess\\u0061ges"]) {
    const result = plan(build(messages, { key }));
    expect(result.refs).toHaveLength(refs);
    expect(result.literals).toHaveLength(refs + 1);
  }
  expect(plan(build(messages, { topLevelArray: true })).refs).toHaveLength(refs);
});

it("其他位置重复键、键顺序、1/1.0、不同转义保留原字节", () => {
  const result = plan(
    build(contentMessages(45, 380), {
      head: '{"model":"a","model":"b","n":1,"m":1.0,"t":"\\u4e2d","messages":',
      separator: ",  ",
      tail: ',"extra":{"k":[1,2,3]}}\r\n',
    }),
  );
  expect(result.refs.length).toBeGreaterThan(10);
  expect(textOf(result, result.literals)).toContain('"model":"a","model":"b","n":1,"m":1.0');
});

it("相同元素保留两个 REF，hashes 只去重一次", () => {
  const duplicate = element(7, 600);
  const result = plan(build([duplicate, duplicate, element(8)]), SHAPE_ONLY);
  expect(result.refs).toHaveLength(3);
  expect(result.hashes).toHaveLength(2);
  expect(result.refs[0].hash.equals(result.refs[1].hash)).toBe(true);
  expect(result.refs[0].start).not.toBe(result.refs[1].start);
});

it("只有 ≥256B 的元素成为 REF，小元素留在 LITERAL", () => {
  const exact = `"${"e".repeat(254)}"`;
  const short = `"${"s".repeat(253)}"`;
  expect(utf8(exact).length).toBe(256);
  const result = plan(build([exact, short], { topLevelArray: true }), {
    ...SHAPE_ONLY,
    minElementBytes: 256,
  });
  expect(result.refs).toHaveLength(1);
  expect(result.refs[0].end - result.refs[0].start).toBe(256);
  expect(textOf(result, result.literals)).toContain("ssss");
  expect(textOf(result, result.literals)).not.toContain("eeee");
});

it("CRLF、Unicode（含代理对）、转义、大整数与指数按原文保留", () => {
  const messages = contentMessages(50, 340);
  const result = plan(build(messages, { separator: ",\r\n  " }));
  const refText = textOf(result, result.refs);
  expect(result.refs).toHaveLength(expectedRefs(messages));
  expect(refText).toContain('"output":-1.25e-30');
  expect(refText).toContain("emoji 😀 🚀 中文");
  expect(refText).toContain("\\ud83d\\ude00");
  expect(refText).toContain("line1\\nline2\\t");
  // 标量元素留在 LITERAL，同样逐字节保留
  expect(textOf(result, result.literals)).toContain("-1.25E+300");
});

it("不递归寻找任意路径的 messages，messages 非数组也不支持", () => {
  expectDegrade(padText('{"a":{"messages":[{"x":1}]}}'), "unsupported-shape");
  expectDegrade(padText('{"messages":{"x":1}}'), "unsupported-shape");
  expectDegrade(padText('{"model":"gpt-4o"}'), "unsupported-shape");
  expectDegrade(padText("[1,2,3]"), "no-candidate");
});

const cases: [string, string, Partial<JsonSliceLimits>][] = [
  ["input-too-large", HEAVY, { maxInputBytes: 1024 }],
  ["input-too-small", HEAVY.slice(0, 4096), {}],
  ["not-json", padText('{"messages":[{"a":1}'), {}],
  ["unsupported-shape", padText('{"a":1}'), {}],
  ["duplicate-messages-key", DUPLICATE_KEY, SHAPE_ONLY],
  ["too-many-elements", SMALL_ARRAY, { ...SHAPE_ONLY, maxElements: 3 }],
  ["too-deep", `[${"[".repeat(4)}"x"${"]".repeat(4)}]`, { ...SHAPE_ONLY, maxDepth: 2 }],
  ["no-candidate", "[]", SHAPE_ONLY],
  ["refs-below-ratio", BELOW_RATIO, { ...SHAPE_ONLY, minRefRatio: 0.5 }],
  ["token-budget-exceeded", HEAVY, { ...SHAPE_ONLY, maxTokens: 10 }],
  ["manifest-too-large", HEAVY, { ...SHAPE_ONLY, maxManifestBytes: 100 }],
  ["manifest-not-smaller", SMALL_ARRAY, { ...SHAPE_ONLY, requireManifestSmaller: true }],
];

it.each(cases)("降级 %s", (reason, source, limits) => {
  expectDegrade(source, reason, limits);
});

it("降级用例表覆盖全部 12 个冻结原因，默认阈值与设计 §4.1 一致", () => {
  expect([...new Set(cases.map(([reason]) => reason))].sort()).toEqual([...FROZEN_REASONS].sort());
  const pinned = Object.entries(JSON_SLICE_DEFAULT_LIMITS)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  expect(pinned).toBe(
    "minInputBytes=16384 maxInputBytes=33554432 minElementBytes=256 minRefRatio=0.5" +
      " maxElements=10000 maxDepth=128 maxTokens=20001 maxManifestBytes=33554432" +
      " requireManifestSmaller=true",
  );
  expect(IO_MESSAGE_HASH_DOMAIN).toBe(HASH_DOMAIN);
});

it("input 恰好 16KiB 通过，少 1 字节降级", () => {
  const exact = padTo(EDGE_BASE, EDGE_REFS, 16 * 1024);
  expect(utf8(exact).length).toBe(16 * 1024);
  expect(plan(exact).refs).toHaveLength(25);
  expectDegrade(padTo(EDGE_BASE, EDGE_REFS, 16 * 1024 - 1), "input-too-small");
});

it("REF 占比恰好 50% 通过，多 1 字节降级", () => {
  expect(plan(padTo(EDGE_BASE, EDGE_REFS, 2 * EDGE_REFS)).refs).toHaveLength(25);
  expectDegrade(padTo(EDGE_BASE, EDGE_REFS, 2 * EDGE_REFS + 1), "refs-below-ratio");
});

it("元素数 10,000 / 10,001、token 20,001 与深度 128 边界", () => {
  const result = plan(MANY, SHAPE_ONLY);
  expect(result.refs).toHaveLength(10_000);
  expect(result.literals).toHaveLength(10_001);
  expectDegrade(MANY.replace('"e9999"', '"e9999","x"'), "too-many-elements", SHAPE_ONLY);
  expectDegrade(MANY, "token-budget-exceeded", { ...SHAPE_ONLY, maxTokens: 20_000 });
  expectDegrade(MANY, "manifest-not-smaller", { ...SHAPE_ONLY, requireManifestSmaller: true });
  const nested = (depth: number) =>
    `[${"[".repeat(depth)}"${"d".repeat(16 * 1024)}"${"]".repeat(depth)}]`;
  expect(plan(nested(127)).refs).toHaveLength(1);
  expectDegrade(nested(128), "too-deep");
  const leaf = `"${"d".repeat(16 * 1024)}"`;
  const nestedObject = (depth: number) => `[${'{"a":'.repeat(depth)}${leaf}${"}".repeat(depth)}]`;
  expectDegrade(nestedObject(130), "too-deep");
  expectDegrade(`{"a":${'{"a":'.repeat(130)}${leaf}${"}".repeat(130)},"messages":[]}`, "too-deep");
});

it("孤立代理项抛错、非 string 抛错、超 32MiB 降级", () => {
  expect(() => planJsonSlices(`\ud800${"x".repeat(17 * 1024)}`)).toThrow("IO_TEXT_INVALID_UTF16");
  expect(() => planJsonSlices(`"\ude00"${"x".repeat(17 * 1024)}`)).toThrow("IO_TEXT_INVALID_UTF16");
  expect(() => planJsonSlices(0 as unknown as string)).toThrow("IO_CAS_INVALID_INPUT");
  expect(() => planJsonSlices(null as unknown as string)).toThrow("IO_CAS_INVALID_INPUT");
  expect(plan(HEAVY).refs.length).toBeGreaterThan(10);
  expectDegrade(`{"messages":["${"x".repeat(32 * 1024 * 1024)}"]}`, "input-too-large");
  expectDegrade('{"messages":["x"]}', "input-too-large", { maxInputBytes: 8 });
});

interface Sample {
  readonly label: string;
  readonly input: string;
  readonly limits?: Partial<JsonSliceLimits>;
}

function* structuredSamples(): Generator<Sample> {
  for (let variant = 0; variant < 10; variant++) {
    const key = ["messages", "\\u006dessages", "messag\\u0065s"][variant % 3];
    const separator = [",", ", ", ",\n", ",\r\n  "][variant % 4];
    const label = `big+${CONTENT_LABELS}${key === "messages" ? "" : "+escaped-key"}`;
    yield { label, input: build(contentMessages(45, 240 + variant * 8), { separator, key }) };
  }
  const sys = (size: number) => `{"_sys":"${"s".repeat(size)}","messages":`;
  yield {
    label: `big+${CONTENT_LABELS}+literal-ratio`,
    input: build(contentMessages(45, 240), { head: sys(7000) }),
  };
  yield { label: "big+crlf", input: build(contentMessages(45, 240), { separator: ",\r\n\t" }) };
  yield { label: "refs-below-ratio", input: build(contentMessages(60, 260), { head: sys(20000) }) };
  yield { label: "dup-key", input: DUPLICATE_KEY, limits: SHAPE_ONLY };
  yield { label: "dup-key+escaped-key", input: DUPLICATE_ESCAPED_KEY, limits: SHAPE_ONLY };
  yield { label: "no-candidate", input: "[]", limits: SHAPE_ONLY };
  yield { label: "unsupported-shape", input: padText('{"a":{"messages":[{"x":1}]}}') };
  yield { label: "unsupported-shape", input: padText('{"messages":{"x":1}}') };
  yield { label: "invalid-utf16", input: `\ud800${"x".repeat(17 * 1024)}` };
  yield { label: "invalid-utf16", input: `{"messages":["\udfff"]}${" ".repeat(17 * 1024)}` };
  // 语法错误样本：单引号、尾随逗号、前导零、缺逗号、坏转义、裸控制字符、截断字面量
  const BROKEN =
    `{"messages":[{"x":1}#{"messages":[1,2,],"pad":"x"}#{"messages":[],"trailing":1} junk` +
    `#{"messages":[01,2]}#{"messages":[.5,+1,1e]}#{"messages":["raw\u0000control"]}` +
    `#{"messages":["bad\\escape"]}#{'messages':[1]}#{"messages":[1,]}#{"messages":[tru]}`;
  for (const bad of BROKEN.split("#")) yield { label: "non-json", input: padText(bad) };
  yield { label: "small-input", input: "" };
  yield { label: "small-input", input: '{"messages":[]}' };
  for (const limits of [
    { maxElements: 5 },
    { maxTokens: 5 },
    { maxManifestBytes: 64 },
    { maxInputBytes: 2048 },
  ]) {
    yield { label: "over-budget", input: BUDGET_INPUT, limits };
  }
  yield {
    label: "over-budget+deep",
    input: `[${"[".repeat(200)}"${"d".repeat(16 * 1024)}"${"]".repeat(200)}]`,
  };
}

function templateSamples(): Sample[] {
  const templates: Sample[] = [];
  for (let variant = 0; variant < 10; variant++) {
    const key = variant % 3 === 0 ? "\\u006dessages" : "messages";
    const separator = variant % 2 ? ",\r\n" : ",";
    const escaped = key === "messages" ? "" : "+escaped-key";
    const input = build(contentMessages(14, 90 + variant * 9), { separator, key });
    templates.push({ label: `small+${CONTENT_LABELS}${escaped}`, input, limits: SHAPE_ONLY });
  }
  for (let variant = 0; variant < 3; variant++) {
    templates.push({
      label: `big+${CONTENT_LABELS}`,
      input: build(contentMessages(45, 380 + variant), { separator: variant % 2 ? ",\n" : ", " }),
    });
  }
  const deep = (depth: number) =>
    `[${"[".repeat(depth)}"${"p".repeat(16 * 1024)}"${"]".repeat(depth)}]`;
  templates.push({ label: "deep", input: deep(80) });
  templates.push({ label: "over-budget+deep", input: deep(200) });
  templates.push({ label: "over-budget", input: BUDGET_INPUT, limits: { maxElements: 5 } });
  for (const bad of ['{"messages":[{"x":1}', '{"messages":[01,2]}']) {
    templates.push({ label: "non-json", input: padText(bad) });
  }
  return templates;
}

const JUNK = ["x", "}", "]", ",", "'", "//", "NaN", "01", "+1", "\u0000", "'q'"];

/** 确定性伪随机：LCG 取高位，语料只需可复现的均匀取值。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 8) / 16777216;
  };
}

/** 变异返回新 input 与本次真正引入的分类标签。 */
function mutate(input: string, rng: () => number): { input: string; tags: string } {
  const pick = (list: readonly string[]) => list[Math.floor(rng() * list.length)];
  const at = Math.floor(rng() * input.length);
  const head = input.slice(0, at);
  const emit = (value: string, tags: string) => ({ input: value, tags });
  switch (Math.floor(rng() * 7)) {
    case 0:
      return emit(`${head}${pick([" ", "\t", "\n", "\r\n", "  "])}${input.slice(at)}`, "ws+crlf");
    case 1:
      return emit(
        input.replace('"messages"', pick(['"\\u006dessages"', '"messag\\u0065s"'])),
        "escaped-key",
      );
    case 2:
      return emit(input.replace('"messages":', '"messages":[],"messages":'), "dup-key");
    case 3:
      return emit(`${head}${pick(JUNK)}${input.slice(at)}`, "junk");
    case 4:
      return emit(head, "truncated");
    case 5:
      return emit(input.replace("p", pick(["\\u0000", "\\r\\n", '\\"', "\\u4e2d"])), "escape");
    default:
      return emit(input.replace("p", pick(["😀", "中", "😀中"])), "unicode");
  }
}

/** 语料最少样本量（设计 §12「保真与降级」行列举的类别），格式 `tag:最少样本数`。 */
const REQUIRED_MINIMUMS =
  "escape:1000 crlf:1000 unicode:1000 surrogate:1000 bigint:1000 exponent:1000 dup-key:100 escaped-key:1000 non-json:1000 over-budget:100 deep:100 invalid-utf16:2".split(
    " ",
  );

/** 语料必须至少触发一次的降级原因。 */
const CORPUS_REASONS =
  "input-too-large input-too-small not-json unsupported-shape duplicate-messages-key too-many-elements too-deep no-candidate refs-below-ratio token-budget-exceeded manifest-too-large".split(
    " ",
  );

it("≥100,000 生成/变异样本逐字节往返且覆盖全部分类", { timeout: 300_000 }, () => {
  const tags = new Map<string, number>();
  const reasons = new Map<string, number>();
  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  let accepted = 0;
  let total = 0;
  const check = (sample: Sample) => {
    total++;
    for (const tag of sample.label.split("+")) count(tags, tag);
    let result: ReturnType<typeof planJsonSlices>;
    try {
      result = planJsonSlices(sample.input, sample.limits);
    } catch (error) {
      if (!String(error).includes("IO_TEXT_INVALID_UTF16")) {
        throw new Error(`[${sample.label}] 意外异常：${String(error)}`);
      }
      count(reasons, "threw-invalid-utf16");
      return;
    }
    if (result.status !== "ok") {
      if (!FROZEN_REASONS.includes(result.reason)) throw new Error("未知降级原因");
      count(reasons, result.reason);
      return;
    }
    accepted++;
    const problem = verifyPlan(sample.input, result.plan);
    if (problem) throw new Error(`[${sample.label}] ${problem}`);
  };
  for (const sample of structuredSamples()) check(sample);
  const templates = templateSamples();
  const rng = lcg(0x5eed);
  while (total < 100_000) {
    const template = templates[Math.floor(rng() * templates.length)];
    const mutated = mutate(template.input, rng);
    check({
      label: `${template.label}+mutated+${mutated.tags}`,
      input: mutated.input,
      limits: template.limits,
    });
  }
  process.stdout.write(
    `[json-slices] samples=${total} ok=${accepted} degrade=${total - accepted}\n` +
      `[json-slices] tags=${JSON.stringify(Object.fromEntries(tags))}\n` +
      `[json-slices] reasons=${JSON.stringify(Object.fromEntries(reasons))}\n`,
  );
  const atLeast = (map: Map<string, number>, key: string, minimum: number) =>
    expect(map.get(key) ?? 0, `覆盖不足：${key}`).toBeGreaterThanOrEqual(minimum);
  expect(total).toBeGreaterThanOrEqual(100_000);
  expect(accepted).toBeGreaterThanOrEqual(20_000);
  expect(total - accepted).toBeGreaterThanOrEqual(20_000);
  for (const entry of REQUIRED_MINIMUMS) {
    const [tag, minimum] = entry.split(":");
    atLeast(tags, tag, Number(minimum));
  }
  for (const reason of CORPUS_REASONS) atLeast(reasons, reason, 1);
  atLeast(reasons, "threw-invalid-utf16", 1);
});
