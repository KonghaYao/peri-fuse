# 可选 SQLite 引擎（Bun）实施规格

状态：**已实施**（2026-10-11；验收矩阵、与规格的有意偏离和遗留项见文末《实施状态》）。目标是在 `PERIFUSE_ENGINE=sqlite` 时，以 Bun 内置 `bun:sqlite` 替换**本地执行引擎**；默认 embedded Turso、远端 HTTP SDK、Drizzle 驱动、schema、迁移 SQL 和业务接口保持不变。

## 1. 边界与已核对事实

- 沿用 `packages/shared/src/db/remote.ts` 的兼容层模式，返回 Turso `Database` 形状；不得改成 `drizzle-orm/bun-sqlite`，也不把同步接口传播到业务层。
- 唯一分派入口是 `packages/shared/src/db/local.ts:createLocalDatabase`。Gateway 的 `src/db.ts:getDb` 已使用它，不增加第二个引擎开关。
- `createLocalDatabase` 必须保持同步返回；`connect/exec/prepare/get/all/run/close` 保持可等待。`getDb()`、Drizzle client 构造及测试代理因此不需要异步重构。
- 运行时与引擎是两个维度：Bun 同样能运行 Turso；sqlite 本地连接要求 Bun ≥1.4.0。不删除 Turso 依赖及其 pnpm patch，不引入外部服务。
- 默认文件仍为 `langfuse.turso.db`、`telemetry.turso.db`、`gateway.turso.db`，不重命名、不复制、不自动迁移。已有当前版 Turso 文件可被 Bun SQLite 打开；这不等于允许两种引擎同时打开同一文件。
- 本规格只覆盖项目实际依赖的兼容面，不承诺实现整个 Turso SDK（如 `batch`、加密、扩展加载、`transaction` 同步 API、`concurrent` 事务）。不通过类型断言宣称这些能力实际可用。

### 1.1 依赖源码依据

核对版本为 `drizzle-orm@1.0.0-rc.5-5935859`、`@tursodatabase/database@0.8.2`、已打补丁的 `@tursodatabase/database-common@0.8.2`、`bun-types@1.4.2`。以下路径均位于实际安装的 `node_modules/.pnpm/<package-version-peer-suffix>/node_modules/`，升级必须重新核对：

| 源码 | 已确认契约 |
| --- | --- |
| `drizzle-orm/tursodatabase/database.js:4–12`、`driver-core.js:13–29` | `drizzle({ client })` 直接使用传入 client，没有 `instanceof Database` 检查；构造不调用 `connect` |
| `drizzle-orm/tursodatabase/session.js:22–61` | prepare 路径：`await client.prepare(sql)` → 同步 `stmt.raw(mode === "arrays")` → `all/get(...params)`；`values` 固定 `raw(true).all`；非 prepare 的对象路径直接 `client.all/get`；run 使用 `stmt.run` 或 `client.run` |
| 同文件 `63–85` | `client.transactionAsync(callback)` → 可选 `.deferred/.immediate/.exclusive` → 调用函数；传入事务 client 创建子 session；Drizzle 嵌套事务发送 `SAVEPOINT`、`RELEASE SAVEPOINT`、`ROLLBACK TO SAVEPOINT` |
| `drizzle-orm/tursodatabase/codecs.js` | boolean、timestamp、JSON 等由 Drizzle codec 处理；驱动**不调用** `safeIntegers/pluck/iterate/columns/reader`，这些是项目/兼容面要求，不能误称为 Drizzle 的直接调用 |
| `@tursodatabase/database/dist/promise.js:19–29` | 仅继承 common 的 `DatabasePromise`，整数转换还涉及 native 层，不能只看此文件推断 |
| `@tursodatabase/database-common/dist/promise.js:349–395,835–918,1052–1301` | 整个事务占有执行锁，tx 有独立 gate；Statement 模式同步链式设置；get 消费至 DONE 再返回首行；iterate 在 finally reset；run 返回 `{ changes, lastInsertRowid }` |
| `@tursodatabase/database-common/dist/bind.js` | 单对象按命名绑定、数组/展开参数按位置绑定；命名参数使用去前缀的 key；未提供参数可以保留已有绑定 |
| `bun-types/sqlite.d.ts` | Database `readonly/create/safeIntegers/strict`；Statement `values/get/all/run/iterate/columnNames/declaredTypes/finalize`；`inTransaction`；错误 `code/errno`。Bun `raw(...params)` 是字节结果，不是模式开关 |

仅对 `:memory:` 做了 Bun 1.4.2 的无落盘探测：Turso 默认 `9007199254740993` 返回 `9007199254740992`（number），`safeIntegers(true)` 返回精确 bigint，且小整数也变 bigint；run 的 rowid 即使设置 safeIntegers 仍是 number。Turso BLOB 是 Buffer，Bun 是 Uint8Array。Turso `raw/pluck` 是互斥模式，最后一次调用决定模式。Bun `node:worker_threads` 的 eval worker 内可以 `require("bun:sqlite")`。这些探测不代替文件并发、打包及取消验收。

## 2. 配置契约

新增 `resolveLocalEngine(environment = process.env): "turso" | "sqlite"` 到 `connection-config.ts`，由 `local.ts` 导出。只接受 `PERIFUSE_ENGINE`，**不接受 `ENGINE` 别名**：后者过于通用，易与宿主应用或其他工具冲突。存在 `ENGINE` 时完全忽略，不警告、不改变分派。

| 输入/场景 | 确定行为 |
| --- | --- |
| 未设置、空串、全空白 | `turso` |
| `" turso "`、`" sqlite "` | trim 后接受 |
| `SQLITE`、`bun`、其他非空值 | 同步抛错，code=`PERIFUSE_INVALID_ENGINE`；消息 `PERIFUSE_ENGINE must be turso or sqlite`，不回显原始输入 |
| 本地路径 + turso | Node/Bun 均保持现有原生引擎及 options |
| 本地路径 + sqlite + Bun ≥1.4.0 | 选择本规格适配器 |
| 本地路径 + sqlite + Node / Bun 版本过低 | 同步抛错，code=`PERIFUSE_SQLITE_REQUIRES_BUN`；在 mkdir、文件打开和 import 前拒绝；不 fallback |
| 远程 URL + 任意**合法** engine | 仍选 `createRemoteDatabase`；包括 Node 下 `PERIFUSE_ENGINE=sqlite` 的纯远程部署，不要求 Bun |
| 远程 URL + 非法 engine | 仍报配置错误，不掩盖拼写错误 |
| 远端连接、认证或 SQL 失败 | 原错误返回；绝不转为本地 sqlite/turso |

URL 优先级完全不变：`TURSO_<ROLE>_DATABASE_URL` → `TURSO_DATABASE_URL` → 对应旧变量 → 默认路径。role 为 METADATA / TELEMETRY / GATEWAY；旧变量依次为 `DATABASE_URL` / `LANGFUSE_SQLITE_DB_PATH` / `GATEWAY_DB_URL`。token 为 role override → 全局；本地路径丢弃 token。空白值仍视为未配置。

**远程与 engine 不互斥**：engine 只修饰 URL 解析后的本地连接。允许 metadata 远程、telemetry/gateway 本地 sqlite；允许 `TURSO_GATEWAY_DATABASE_URL` 本身是本地文件。保留 `isRemoteDatabaseUrl` 的现有分类规则，不增加协议白名单，不在配置错误中打印 URL/token。

配置在每次创建连接时读取并在该连接生命周期内固定；不支持进程内热切换。worker 继承启动时环境，所有同库进程必须使用相同 engine。CLI 继续按现有 `.env` 合并规则传递环境（当前 `.env` 覆盖 shell），使用 Bun 启动 CLI 才会通过 `process.execPath` 派生 Bun daemon；不自动寻找或下载 Bun。切换前须停止旧 daemon，而不是对已运行实例再次 `start`。

## 3. 模块与分派

### 3.1 文件职责

| 文件 | 后续实施内容 |
| --- | --- |
| `packages/shared/src/db/connection-config.ts` | 纯函数 `resolveLocalEngine`，不加载 Bun |
| `packages/shared/src/db/local.ts` | 配置校验和分派；迁移前 WAL 激活钩子；保留既有导出与路径算法 |
| `packages/shared/src/db/sqlite.ts`（新增） | 同步 factory、lazy connect、close、Database executor、内部 WeakMap/类型收窄与 WAL 激活钩子 |
| `packages/shared/src/db/sqlite-statement.ts`（新增） | Statement、参数绑定、行/值转换、迭代与 finally 清理 |
| `packages/shared/src/db/sqlite-transaction.ts`（新增） | FIFO gate、AsyncLocalStorage 所有者检查、事务句柄、BEGIN 重试与回滚 |
| `packages/cli/build.mjs` | 所有相关 esbuild 调用将 `bun:sqlite` external，包括 server、`dist/src/db/local.js`、indexer/backfill |
| `packages/shared/package.json` / `tsconfig.json` | shared 显式添加与 Bun 基线一致的 `@types/bun` devDependency；types 增加 `bun`；不可依赖偶然存在的间接类型包 |

每文件不得超过 500 行；模块只拆上述职责，不引入通用多数据库框架。Gateway 不改 schema、驱动或构造逻辑。shared 前端入口不得导出 sqlite 模块。Bun 运行时迁移另行管理，本任务不改 CLI 为 ESM、不改 package manager、不移除 Node 支持。

### 3.2 加载与类型边界

`local.ts` 可以静态导入 `createSqliteDatabase`，但 sqlite 模块顶层只能有 `import type ... from "bun:sqlite"`。真实 `await import("bun:sqlite")` **只在 connect 内**执行；不能在模块顶层动态 import，也不能用顶层 await。采用以下流程，保持同步构造接口：

```ts
// 仅为分派骨架；现有目录创建和 Turso options 保持原样。
const engine = resolveLocalEngine();
const config = validateDatabaseConfig({ url, authToken });
if (isRemoteDatabaseUrl(config.url)) return createRemoteDatabase(config, readonly);
if (engine === "sqlite") assertSqliteRuntime();
const filename = resolveLocalPath(config.url);
// writable 非 memory 时沿用 mkdirSync(dirname(filename), { recursive: true })。
if (engine === "sqlite") return createSqliteDatabase(filename, readonly);
// 否则沿用 new Database(filename, ...)。
```

runtime guard 检查 `process.versions.bun`，解析 major/minor/patch 数字元组而非字符串比较，要求 ≥1.4.0；真正的模块加载失败保留 cause 且报初始化失败，不改用另一引擎。factory 不打开文件，connect 保存单个 Promise，所有 DB 操作先 await connect。并发 connect 只创建一次底层句柄；失败关闭半初始化句柄，连接进入 failed，不原地重试；调用方新建连接。

使用 `typeof import("bun:sqlite")`、`import type { Database as BunDatabase, Statement as BunStatement }` 描述 native 类型；对 unknown 参数以类型守卫收窄。定义显式内部 executor/statement/transaction 结构并做编译检查。仅 factory 返回和 tx 交给回调处允许与 remote.ts 一致的 `as unknown as Database/Transaction`；不引入 `as any`。使用 WeakMap 存储 native 状态、引擎身份，不靠业务方 `instanceof`，也不修改 `LocalDatabase = Database` / `LocalExecutor = Database | Transaction` 的公共类型。

`initializeLocalDatabase` 仍 await connect 再 foreign_keys；connect 自身也必须设置外键，因为读 worker 当前只调用 connect。`openLocalDatabase` 继续关闭初始化失败的句柄。`resolveLocalPath/localFileExists/resolveDatabaseWorkerModule` 算法不变，后者仍加载构建出的 `dist/src/db/local.js`。

## 4. Adapter 方法契约

### 4.1 Database / Transaction executor

所有 SQL 方法的同步 native 异常转为 Promise rejection，保留 SQLite `code/errno/cause`，不得拼接绑定值。readonly 是 native 打开标志，不是 SQL 前缀正则。事务句柄只提供下表 executor 和 `open`，**不提供 `transactionAsync`**。

| 方法 | 实现与返回 |
| --- | --- |
| `name` | resolve 后绝对文件名或 `:memory:`，与 session-search 的 `db.name` 用法兼容 |
| `connect(): Promise<void>` | 状态 new → connecting → open；动态加载模块并创建 `new BunDatabase(filename, { readonly, create: !readonly, strict: false, safeIntegers: true })`；readonly 缺失文件拒绝且不创建目录/文件；不接受 readonly memory，报 `PERIFUSE_SQLITE_READONLY_MEMORY` |
| `close(): Promise<void>` | 幂等，共享 close Promise；先标记 closing 拒绝新任务，等待已接收任务/事务；终止存活迭代器并 finalize Statements，最后 `native.close(true)`；未 connect 可直接 closed；连接失败也能 close；事务回调内调用父 close 立即拒绝，不能等待自己 |
| `exec(sql): Promise<void>` | native `exec` 执行完整 SQL 序列，不按分号拆分（字符串、trigger 中可能含分号）；支持迁移块；默认不自动事务化，多语句失败可有前序提交，**不重试 exec** |
| `prepare(sql): Promise<Statement>` | 在 gate 内创建 native `prepare`（不用隐含缓存的 `query`），包装并登记资源；空/无语句 SQL 拒绝；返回后 columns/reader 已可同步读；语句针对单条 SQL，序列应走 exec |
| `run(sql, ...params)` | 临时 prepare → run → finally close；返回 `{ changes: number, lastInsertRowid: number }` |
| `get(sql, ...params)` | 临时 Statement.get；首行或 `undefined`，不是 Bun 的无行 `null`；确保执行到 DONE，见 4.2 |
| `all(sql, ...params)` | 临时 Statement.all；默认对象数组，无结果 `[]` |
| `iterate(sql, parameters?, options?)` | AsyncGenerator，临时 prepare → `yield* stmt.iterate(parameters, options)` → finally close；break/throw/return 必须清理 |
| `transactionAsync(callback)` | 同步返回可调用函数，调用后 Promise；默认等价 deferred，三个形态见第 6 节；callback 非函数同步 TypeError；与 remote 一样不按 `callback.length` 禁止零形参函数 |

run 的 `changes` 不得受前一条 DML 污染：同一 gate 内执行前后取 `total_changes()`，没变化则 0，否则用本次 native run 的 changes；两次统计查询都用独立 native 语句并 finalize。rowid 始终 `Number(nativeResult.lastInsertRowid)`，即使 Statement safeIntegers=true 也如此，这是当前 Turso 实测行为。DDL、SELECT、SAVEPOINT 在前面有写入时也要测 changes=0。

raw SQL 显式 BEGIN/COMMIT 不是业务事务 API；生产调用只准用 transactionAsync，Drizzle 生成的 savepoint 通过 tx.run 原样执行。不得用 SQL 正则封锁 SAVEPOINT。

### 4.2 Statement

持有独立 `rowMode: "object" | "array" | "pluck"`、`safe: boolean=false`、native 句柄、所属 executor、closed/active 标志。每次执行在进入异步队列前快照 mode、安全整数设置、绑定参数（含 Buffer 自有副本）；绑定记忆的合并在取得 gate 后按队列顺序进行。同一 Statement 并行调用必须串行，不让下一次绑定覆盖仍在消费的游标。

| 方法/属性 | 确定语义 |
| --- | --- |
| `columns()` | 同步返回按列序的 `{ name, type, column: null, table: null, database: null }[]`；name 来自 columnNames，type 来自 declaredTypes（表达式为 null）；不使用会读取首行的 columnTypes。这里与已测 Turso 一致，不虚构表来源元数据 |
| `reader` | `columnNames.length > 0`；INSERT RETURNING 也是 true，**绝不能作为 readonly 判断** |
| `raw(enabled=true)` | true → array；false → object；同步返回本 wrapper，并清除先前 pluck 模式 |
| `pluck(enabled=true)` | true → pluck；false → object；同步返回本 wrapper，并清除先前 raw 模式。remote.ts 的流式分支保存两个布尔值，不能照搬该细节；以 native Turso 实测互斥行为为准 |
| `safeIntegers(enabled=true)` | 仅改变 wrapper 输出转换；同步返回 wrapper；native 始终 safeIntegers=true，不随此开关变动 |
| `all(...params)` | native `values(...bindings)` 取得按序值数组，再转换成目标模式；不能用 Object.values，重复列名会丢失原始列 |
| `get(...params)` | 以与 all 相同的消费逻辑执行到 DONE，取转换后的首行；无行 undefined；这是 Turso get 对 DML RETURNING 也完整执行的行为。不得仅调用 Bun get 然后丢弃剩余步骤 |
| `run(...params)` | 执行到 DONE，忽略返回行；返回 4.1 的结果；mode 不影响 run |
| `iterate(parameters?, options?)` | 对象模式走 native `iterate`，逐行复制/转换；array/pluck 模式走 native `values` 后逐行 yield（准确保留重复列及第一列）；所有路径 finally 归还 gate、关闭游标 |
| `close(): void` | 同步幂等 finalize，若有活跃 iterator 先 return；之后所有执行/模式方法拒绝；cached.close() 无需 await，与读池逐出逻辑相同 |

对象构造用 `Object.fromEntries`，重复列名最后一列覆盖前面（与 native 对象模式一致），`__proto__` 等列名不得触发原型修改。array 保留重复列的全部位置；pluck 只取第 0 列，SQL NULL 就是 null。

**已选择的流式边界**：Bun 公共 iterate 返回对象，不能在重复列名场景还原位置数组。首版不使用 undocumented `Statement.native`、FFI、SQL 改写或 OFFSET 重跑；raw/pluck iterate 明确是物化后迭代，与 all 具有相同内存占用。项目大结果读池和 telemetry 只用对象模式，必须保持真正逐行迭代，不许把它们改成 all。为 get 物化大结果是兼容性成本，业务应使用 LIMIT 1；本次不主动重写查询。

native iterator 的 `return()` 在 finally 调用；提前结束后缓存 Statement 必须可复用。运行到第 256 行、512 行等边界执行一次 `await new Promise(resolve => setTimeout(resolve, 0))`，让取消及关闭可被处理；此时仍持有连接 gate。close 可请求 iterator 停止并等待当前一步完成，不强行并发 finalize 正在 native 调用的句柄。调用者必须消费或 return 迭代器，不得从事务中返回仍活跃的 iterator。

### 4.3 参数绑定

先按 remote.ts `statementArguments` 的规则归一化：只有一个非 null 对象且不是 Uint8Array 时取该对象，否则取参数数组。Array 是位置参数列表；Buffer 属于 Uint8Array，必须是**一个 BLOB 参数**，不能被展开。单对象不是 JSON 值，始终解释为命名绑定；JSON 值必须由业务/Drizzle 序列化。

- `get(1, "x")` 与 `get([1, "x"])` 等价；多参数内嵌数组只展开一层，与 common `bindPositionalParams` 一致。位置绑定同样需要 wrapper 记忆：创建长度为 `native.paramsCount`、初值 null 的槽数组，按本轮提供的位置更新，undefined 和未提供的位置保留旧值，每次向 Bun 提交完整槽数组；超过 paramsCount 拒绝。Bun 1.4.2 会拒绝缺少的位置参数，不能原样转发 Turso 的部分绑定。使用 Uint8Array/Buffer 的 byteOffset/byteLength，不绑定整个共享底层 ArrayBuffer。
- 命名对象要求普通对象或 null-prototype 对象，只读取 own enumerable keys。Turso 用 `{ id: value }` 绑定 `:id/$id/@id`；sqlite 以 `strict:false` 打开，对每个无前缀 key 显式构造 `:key/$key/@key` 的映射后交给 Bun。Turso 对前缀 key 如 `{ ":id": 1 }` 不按无前缀 id 绑定，兼容层不得悄悄扩展成另一套语义。
- undefined 命名值略过；首次未绑定槽为 NULL；重复执行时遗漏槽保留上一轮绑定，遵循 native Turso 语义，不强制 strict:true。Bun 1.4.2 实测传部分对象会把其他槽清为 NULL，**wrapper 必须保存每个 Statement 已绑定的无前缀命名值**，每次合并新 own keys 后展开三个前缀再提交；空对象/无参数复用已保存映射。缓存保存 Buffer 的自有副本，close 时释放。不得直接传部分对象给 Bun。
- 位置 undefined 不覆盖原槽（首次等价 null）；允许 null/string/finite number/bigint/boolean/Uint8Array，boolean 转 0/1，bigint 先验证有符号 64 位范围。Date、函数、symbol、任意对象值及其他 typed array 作为单值均 TypeError，不隐式 JSON/string 化；这部分是明确的项目输入子集，不承诺整个 Turso 的宽松 coercion。一个 Statement 首次非空绑定确定 positional/named 模式，之后不允许跨模式混用（空数组/空对象/无参数仅复用既有绑定）；项目调用未依赖混合模式，此限制须测试并文档化。
- prepare 后 native 负责检查 SQL 语法/实际参数索引和数量；不自己扫描 SQL 查找占位符。参数错误不包含绑定值。
- `iterate(params, { queryTimeout })` 必须识别第二个 options，而不是当位置参数；其他 get/all/run 同样接受“至少两个实参且末项 own-property queryTimeout”的 options，与 common `splitBindParameters` 一致。单个 `{ queryTimeout: value }` 仍可为命名绑定。exec 的第二项是 options，不是绑定。

## 5. 值类型与 schema 一致性

底层统一 `safeIntegers:true` 保留精度，再在边界转换，避免 Bun 默认整数转换的实现细节。**不能使用“大于 MAX_SAFE_INTEGER 才 bigint”的自动模式**，否则 Drizzle 两引擎表现不同。

| SQLite 值 | 默认输出 / `safeIntegers(false)` | `safeIntegers(true)` |
| --- | --- | --- |
| INTEGER | `Number(bigint)`，包含超过 ±(2^53−1) 时的 JS 舍入 | 所有整数 bigint，包括 0、1、count 和小 rowid 查询 |
| REAL | number；不会因值刚好为整数而改成 bigint | 同左 |
| TEXT | 原 string，不解析日期/JSON | 同左 |
| BLOB | `Buffer.from(nativeUint8Array)` 复制，保证内容在 native reset/跨线程后仍有效 | 同左 |
| NULL | null；与 get 无行 undefined 区分 | 同左 |

bigint 输入范围为 `[-9223372036854775808n, 9223372036854775807n]`，越界 TypeError，不允许 Bun 截断。精确大整数必须以 bigint 绑定并通过 safeIntegers(true) 读取；已舍入的 number 输入不可恢复精度。SQL literal、边界 ±(2^53−1)、±2^53、±(2^53+1)、int64 两端都必须差分测试。run 元信息遵循第 4 节，不能受行安全整数开关影响。

已 grep 项目 schema：metadata `schema/tables-*.ts` 大量使用 `integer(...,{mode:"boolean"})` 和 `timestamp_ms`；其余 plain integer/text 仍按原样。telemetry `traces/observations` 的时间为 TEXT、标志位为 plain INTEGER、metadata/tags 为 JSON 文本，input/output 是 `blob(...,{mode:"buffer"})` 配合 codec/raw-size。Gateway 的 isEnabled 是 boolean mode，时间是 ISO-8601 TEXT，配置是 TEXT。当前这些 schema **没有 `mode:"json"` 配置**，不能假设所有 text 自动 JSON.parse。

adapter 不做 boolean/Date/JSON 的读取变换：Drizzle boolean codec 得到 0/1 后返回 boolean，timestamp_ms 得到毫秒 number 后返回 Date；raw SQL 保留数字。JSON.stringify/parse、压缩 BLOB 解码继续由现有域层承担。测试另建 text:json / blob:json 小表验证 pinned Drizzle codec，不能为测试修改生产 schema。项目隔离字段和约束完全不变。

## 6. 事务、所有权与关闭

**首版使用一个 Database 一个 native 连接，加异步 FIFO gate**，不仿照 remote 每事务新建连接：新建会破坏 `:memory:` 的同库语义，且增加文件句柄/锁竞争。remote 的 executor/回调接口沿用，连接策略不照搬。同步 SQL 不代表 async callback 期间自动互斥。

1. `transactionAsync(callback)` 返回默认 callable 及 `.deferred/.immediate/.exclusive`，每个接收 `...args` 并返回 `Promise<T>`；传给回调 `callback(tx, ...args)`，将其返回值作为结果。默认执行 `BEGIN DEFERRED`，不实现 BEGIN CONCURRENT。
2. 执行前 await connect，检查 readonly（所有事务形态都拒绝，即使只读回调），获取父 gate；readonly 用 `SQLITE_READONLY` / `Database is read-only`，不运行回调。
3. 在锁内运行 `BEGIN <mode>`。SQLite WAL 下 IMMEDIATE/EXCLUSIVE 都取得单写者位置，EXCLUSIVE **不会阻止 WAL 读者**；DEFERRED 直到读/写才建立对应锁，读后升级写可能发生 BUSY_SNAPSHOT。
4. BEGIN 成功后设 begun=true，在 `AsyncLocalStorage` 作用域记录 `{ databaseId, transactionId, active }`；创建不带 transactionAsync 的 tx executor，执行其专属串行 gate，不重新获取父 gate。每个 tx 方法及 tx.prepare 得到的 Statement 都要检查 active（入队前和真正执行前）。
5. `await callback` 成功后，先请求关闭事务内活跃 iterator（它持有 tx gate，不能先等后续任务排空），排空已登记 tx 操作，再 COMMIT；callback 抛错时也先终止 iterator 并等已接受操作退出，然后处理回滚。失败（包括 COMMIT 失败）在 native.inTransaction 仍为 true 时 ROLLBACK。若 SQLite 已自动结束事务，不发送多余 ROLLBACK。回滚失败不得静默吞掉：以 AggregateError 保存原错误及 rollbackError，并将连接标记 failed，之后拒绝使用。
6. finally 将 tx 标记 inactive，finalize 其 Statements，释放父 gate。事务结束后 `tx.open=false`，任何 tx/关联 Statement 执行都以 `PERIFUSE_TRANSACTION_CLOSED` 拒绝。不得让脱离回调的后台任务重用句柄；晚到任务只会失败。
7. 同一连接的其他请求在父 FIFO gate 排队，不会混入事务。回调上下文内误用父 `db.run/get/all/exec/prepare/iterate/transactionAsync/close` 立即拒绝 `PERIFUSE_TRANSACTION_REENTRY`，不能排队死锁；作用域已结束但继承旧 context 的后台任务同样拒绝。不同数据库连接不因这个检查被误伤，但回调不应等待另一个争抢同一文件写锁的连接。
8. adapter 层不支持嵌套 transactionAsync。`withLocalTransaction(db, cb)` 经父 transactionAsync.immediate；`withLocalTransaction(tx, cb)` 因无 transactionAsync 直接复用 tx；Drizzle `tx.transaction` 使用现有 SQL savepoint，支持嵌套提交与局部回滚，不建立第二个 native transaction。

同一 tx 内 `Promise.all(tx.run(...))` 按调用顺序串行；队列链必须用 finally 释放，前一项 reject 不毒化后续队列。回调必须 await 所有任务，adapter 仍追踪已接受操作并在结束前排空；回调完成时仍 pending 的操作若失败，也须使事务失败。回调内已显式处理的语句错误不永久毒化事务，尤其 Drizzle rollback-to-savepoint 后必须允许外层继续提交；不能用“本事务曾有 reject”标志强制外层回滚。close 拒绝新任务，但已接受事务中的 tx 仍允许完成；正在流式读取时请求 return。close 不自动回滚健康且仍执行中的业务 callback，不引入隐式 callback 超时。

### 6.1 迁移与 legacy 拒绝

`applyLocalMigrations` 的行为保持：初始化 → 检查 legacy → 建迁移表 → **每个 migration 一个 IMMEDIATE 事务**，事务内复查迁移名、执行各 breakpoint 块、写入迁移记录。失败仅回滚该 migration，之前成功的迁移保留；两启动进程必须在事务内复查，不能在事务外缓存“尚未应用”。DDL 必须与 INSERT 一起回滚。sqlite 分支额外将 `CREATE TABLE IF NOT EXISTS _perifuse_migrations` 放入单独的 IMMEDIATE 初始化事务，使并发启动可通过 BEGIN 重试，不能对这条 DDL 的 exec 直接重放；其他引擎保留现状。

为避免 `journal_mode=WAL` 在 legacy 校验前改写旧库头，新增 sqlite 专用 `ensureSqliteWal(db)` 内部钩子：connect 对文件只设 connection-local PRAGMA；`applyLocalMigrations` 在 legacy 检查通过后、CREATE 迁移表之前调用钩子。非 sqlite 对象是 no-op。所有 writable 通用 SQL 操作（含 get/all/prepare/iterate）首次执行前在 gate 中激活 WAL，不通过 SQL 正则或 EXPLAIN opcode 判断是否写入。

唯一例外是 legacy preflight：增加内部 `inspectSqliteTables(db)` 钩子，在 gate 内直接只读查询 sqlite_master，返回与当前 tables 查询相同的 `{ name: string }[]`，不触发 WAL。`applyLocalMigrations` 以 WeakMap 类型守卫识别 sqlite 并使用此钩子，其他引擎保留原查询。如此保证该入口的 legacy 拒绝在任何持久化 PRAGMA 之前完成；普通通用查询不是 legacy 检查入口，不承诺对 writable 连接不改 journal mode。初始化的 foreign_keys 使用内部专用路径，不经普通 exec 提前激活。`ensureSqliteWal` 在父 gate 内执行且只初始化一次，失败不设置成功标志；普通父 executor 在取得 gate 后调用，事务在 BEGIN 前调用，tx executor 内不再调用，避免重新获取 gate 或事务中切 journal mode。

readonly 不激活 WAL，不写迁移、不创建文件。memory 跳过 WAL。`initializeLocalDatabase` 对 sqlite 的外键已由 connect 设置，使用钩子/幂等初始化，不再经普通 exec 激活 WAL。legacy 拒绝测试比较主文件及已有 WAL 内容，不能以仅“未创建业务表”替代。

## 7. 并发、PRAGMA 与 SQLITE_BUSY

### 7.1 与 Turso 最大差异

**bun:sqlite 没有 `experimental: ["multiprocess_wal"]`。使用 SQLite 自身 WAL + 文件锁，每文件同时只有一个写事务；Promise 包装不会使 native SQL 异步，也不会使同线程长查询可中断。** `LOCAL_DATABASE_OPTIONS` 只传 Turso；不把它塞进 Bun options。

| PRAGMA | 时机和值 |
| --- | --- |
| `busy_timeout=50` | connect 每个句柄设置，单位 ms；不用 Turso 的同步等待 5000ms，避免长时间阻塞事件循环 |
| `foreign_keys=ON` | connect 每个句柄、BEGIN 之前设置，并读回验证为 1（native safe 模式是 1n）；readonly 同样设置 |
| `journal_mode=WAL` | writable 文件在 6.1 的钩子激活一次，读回必须是 wal；未成功不得运行写任务；readonly 只查询、不尝试设置；memory 实际为 memory，允许 |
| `synchronous=FULL` | writable connect 设置，保留持久性优先，不偷偷降级 NORMAL/OFF |
| `wal_autocheckpoint=1000` | writable connect 设置；不在每次事务/close 主动 TRUNCATE，不强迫长读者退出 |

readonly 必须以 native readonly 打开；native 拒绝 DML、CTE 写、RETURNING 写、DDL。可以在 prepare 阶段成功编译写语句，**执行时**必须失败（这与 remote.describe 提前拒绝不同）。不把 `reader=true` 当可读安全许可，不以 `PRAGMA query_only` 代替 readonly。此接口不是通用不可信 SQL 沙箱；不向用户暴露任意 SQL/ATTACH。

### 7.2 重试策略（首版固定，不增加环境变量）

- 可重试范围仅：`BEGIN IMMEDIATE/EXCLUSIVE/DEFERRED` 在尚未成功时，以及独立 WAL 激活 PRAGMA。无业务副作用，回调尚未调用。
- 匹配有结构的 code/errno：仅 primary SQLITE_BUSY（errno & 255 等于 5），排除 `SQLITE_BUSY_SNAPSHOT`（517）；包括非 snapshot 的 BUSY 扩展码。不按 error.message 包含 busy 来重试。SQLITE_LOCKED、READONLY、CONSTRAINT、IOERR、INTERRUPT 原样失败。
- 每次 native 等待最多 50ms；失败后 timer 退避 `min(10 * 2^attempt, 200)` ms，加 0–25ms 均匀 jitter；以第一次尝试起算的单调时钟总预算 5000ms，最后一次 sleep/尝试不得无界超预算。测试注入 clock/sleep/random，不做真实 5 秒单测等待。
- budget 耗尽抛最后 SQLite 错误，保留 code/cause，并附不含 SQL/参数的 attemptCount、elapsedMs。WAL 初始化失败使连接不可用；BEGIN 失败释放 gate且不 ROLLBACK 未开始的事务。
- **不自动重跑 callback、不自动重试 COMMIT、exec、普通 run/get/all 或已开始的 iterate**。exec 可能已部分执行；callback 可能包含 HTTP/日志等外部副作用；DEFERRED snapshot 冲突必须整事务由上层明确重做。本次不增加上层隐式重试。
- 正常业务写入及迁移已有 IMMEDIATE 事务，应通过 BEGIN 重试解决竞争；零散自动提交写如 lifecycle 状态更新可以返回 BUSY，交给现有下一 tick 的恢复逻辑。不得把操作失败返回成成功。

### 7.3 worker、多进程与超时

- 每个 worker 自己建立 native 连接，不跨线程传 Database/Statement。读池保留 readonly、缓存上限 256、SQL bytes 上限、行数/bytes 上限；搜索 worker 是**写 worker**，保留 IMMEDIATE/批量 100 的业务逻辑。
- 当前源码并非所有 worker 都调用 openLocalDatabase：读 worker 调 createLocalDatabase + connect，搜索 worker调 createLocalDatabase + initializeLocalDatabase。因此 connect 必须足够完整；不能仅修改 openLocalDatabase。
- server、独立 gateway 和 CLI daemon 可用同一文件（显式把三 role URL 配成同一绝对路径）或默认三文件。共库时事务串行写，WAL reader 可与 writer 并行；CLI 自身是管理器，daemon 才是写者。默认三文件不是一个跨库事务。
- 文件放本地支持 SQLite 锁的磁盘，不支持 NFS/SMB 上多机共写。长 reader 会阻止 checkpoint 推进、使 WAL 增长；运营上缩短查询、分页或停止读者，禁止删除活跃 WAL/SHM。不同引擎不可混开，无进程间自动探测/切换保证。
- 接受 QueryOptions.queryTimeout 正有限毫秒；在排队、retry、每次 iterator.next 前后检查 deadline，超时抛 `SQLITE_INTERRUPT`。不能声称 timer 能打断一个同步 native step；all/values/get 的检查可能在 SQL 返回后才生效。
- 文件型查询保持读池默认开启；父线程现有超时会 reject 请求并 terminate worker，替补 worker 必须确认旧 worker 已 exit 才接单。**Bun terminate 对正在 native SQL 中的 worker 的及时性待验证，是发布门槛**。若不满足验收，sqlite 不得标为支持现有硬取消契约；不要悄悄关闭取消或无限增建 worker。
- `PERIFUSE_READ_WORKERS=0` 和 memory 直读明确只有协作式超时，长聚合可阻塞主线程；该模式仅适合受控、小查询。不为首版增加写 worker、FFI interrupt 或整个数据库 RPC 化。

## 8. 测试与验收

### 8.1 执行矩阵

保留 Node ≥22.12 + turso 的现有全套测试，增加 Bun ≥1.4 + turso、Bun ≥1.4 + sqlite 两组。Bun 最低版和当前 1.4.2 至少分别跑 adapter/worker smoke；Node + sqlite 本地必须验证拒绝，远程必须验证仍可用。不得仅把 `PERIFUSE_ENGINE=sqlite` 前缀加在 pnpm 命令上就认为子测试运行在 Bun；用 `process.versions.bun` 断言实际 runtime。

既有 Vitest（pool=forks）继续使用，不改成 bun:test。实施后用 `bun --bun <实际解析的 vitest/vitest.mjs> run ...` 并检查测试进程和 eval worker runtime；若 fork 被启动为 Node，测试配置显式传 Bun execPath。Node legacy 迁移测试保持单独作业，因为它使用 `node:sqlite`、`--experimental-sqlite` 和 `NODE_BINARY=process.execPath`。本设计阶段未运行会写构建/测试产物的命令。

所有矩阵只使用临时目录与自建 HTTP 测试服务器；保留测试配置清理继承 `TURSO_*` 的防误连逻辑。矩阵显式设置 engine，配置测试通过 stub 环境并恢复，不依赖开发者 shell。先构建 shared/Gateway/MCP，worker 必须导入本次新构建的 dist，不得误测旧产物。

### 8.2 用例归属

下表路径除注明外相对 `packages/shared/src/`；新增大文件按职责拆分，每文件 ≤500 行。

| 文件 | 必须覆盖的断言 |
| --- | --- |
| `db/connection-config.test.ts`（现有） | trim/default/非法/大小写/ENGINE 忽略；URL/token 原优先级全部保留；remote 优先、混合 role、本地不使用 token；错误不回显输入 |
| `db/local.test.ts`（现有） | 默认与显式 turso；sqlite 分派、Node 错误、路径/mkdir/fileMustExist；迁移失败回滚、重复启动、legacy 无修改；Drizzle 外键/嵌套 savepoint/BLOB。当前“worker same WAL options”直接 import Turso，保留为 Turso 专属，新增经 local.js 的 sqlite 对应测试，不把旧测试当新引擎覆盖 |
| `db/sqlite.test.ts`（新增） | connect 幂等/失败清理、未连接自动 connect、close 重入/排空、closed Statements；readonly 文件缺失不创建、只读 SELECT、所有执行入口拒绝写与事务、RETURNING reader=true；memory 跳过 WAL、readonly memory 明确拒绝；PRAGMA 读回 |
| `db/sqlite-statement.test.ts`（新增） | raw/pluck 最后调用优先、取消模式、columns/reader；无行 undefined/空 all/SQL NULL；重复列/首列/__proto__；展开/数组/单对象/空对象/Buffer 切片/命名前缀/绑定复用/queryTimeout 分离；iteration break/error 后可重用；DDL/SELECT run 的 changes 与 rowid；get 的 RETURNING 完整执行 |
| `db/sqlite-values.test.ts`（新增） | Turso/Bun 同进程独立 memory 库差分 INTEGER/REAL/TEXT/BLOB/NULL、正负边界、默认 vs safe true/false；Buffer 所有权；真实 metadata boolean/Date 与 telemetry/Gateway 文本时间、JSON、压缩 IO 往返；额外小表验证 Drizzle json codec |
| `db/sqlite-transaction.test.ts`（新增） | 默认/deferred/immediate/exclusive 的 BEGIN；args/返回值；回调/COMMIT/ROLLBACK 异常；readonly；父连接重入快速失败；其他请求 FIFO 不混入；tx Promise.all 排队；失效 tx/Statement；withLocalTransaction(tx) 不二次 BEGIN；Drizzle 多层 savepoint；testing.ts rejectSql 注入能回滚 |
| `db/sqlite-concurrency.test.ts`（新增） | 注入时钟验证 BEGIN 退避/预算/错误分类/回调只调用一次；真实两个连接 held-lock 释放后成功、超过预算失败；DEFERRED snapshot 升级失败且无自动重放；无 exec/COMMIT 重试；多进程同迁移名仅执行一次、长 reader 与写入/检查点 |
| `db/remote.test.ts`（现有） | 保持全部 HTTP/readonly/streaming/事务/worker 测试；添加合法 sqlite 配置不改 remote 路由、非法值拒绝、远端失败不创建本地文件 |
| `db/legacy-migration.test.ts`（现有，Node 作业） | 全套仍跑；迁移脚本继续是显式 Node→Turso 离线工具，不强改引擎。新增迁移产物验证阶段派生 Bun sqlite 只读检查 bigint/BLOB/三角色计数；另测当前 Turso→sqlite 写→Turso 的停机切换，不能只测打开成功 |
| `server/adapters/sqlite-read-pool.test.ts`（现有） | sqlite 模式加载 dist/local.js、继承 engine、readonly、看到已提交写、行/bytes限制、超时/取消后 exit 与替补、结果无残留、cache 逐出 finalize；大结果 RSS 不随全集增长 |
| `server/session-search/lifecycle.test.ts`、`worker-source.test.ts`（现有） | Bun worker 启停、实际 engine、dirty/backfill 消费、失败后 tick 恢复、主连接并发写、退出释放锁；继续跑 query/context/backfill 测试 |
| `packages/gateway/src/__tests__/sqlite-engine.test.ts`（新增） | getDb 同步、ensureSchema、spend 事务回滚/并发扣账、close；两个 project 数据不得互读/互写，现有鉴权/项目隔离测试必须全跑 |
| `packages/cli/src/__tests__/sqlite-engine.test.ts`（新增） | Bun 运行 CJS server/worker bundle、临时 HOME 中 daemon 的 engine/runtime 继承、stop 等待退出；Node 默认模式无需解析 bun:sqlite；Node sqlite 不创建库；产物不内联 Bun builtin |

### 8.3 必须记录的压力验收

由 `db/sqlite-concurrency.test.ts` 的长测（独立显式启动，不进每次快速单测）及 CLI 集成测试组成，不访问真实库。保存 runtime/OS/CPU/磁盘、请求分布、延迟分位数、BUSY 次数、WAL 大小和事件循环延迟；只记录统计与错误码，不记录 SQL 参数、业务行或凭据。

1. **共库负载**：本地磁盘临时文件；三个 Bun 子进程分别模拟 server、gateway、daemon 写者，每进程 4 个逻辑并发，每事务写 20 行并更新一个共享计数器，IMMEDIATE；每进程 1000 个事务，共 60000 行。另起 4 个 readonly eval workers 循环 count/分页；跨两 project 写不同主键，验收行数与 counter 精确一致，无重复/丢失/跨项目数据，无未处理错误，100% 已应答成功事务可查。每轮最多 120 秒，连续 3 轮。
2. **竞争与事件循环**：独立进程持写锁 250ms，等待方成功且 callback 只运行一次；持锁 6000ms，等待方在预算 5000ms + 250ms 调度容差内拒绝，callback 为 0 次、没有残留事务，释放锁后新事务成功。后台 10ms 心跳在此专门场景单次最大间隔 <250ms，不允许同步 busy_timeout=5000。
3. **隔离与持久性**：读 worker 在 writer 未提交时看不到新行，提交后新查询可见；DEFERRED 读 snapshot 后另一连接提交再升级写应返回 snapshot 冲突；随机终止一个尚未提交的写进程，重开 `PRAGMA integrity_check`=ok、foreign_key_check 为空、只能出现完整已提交批次。
4. **迁移竞争**：先单进程应用基线，再三个进程同时应用一条带计数表写入的迁移；schema/日志/副作用各一次。另做三进程同时从空库启动，若既有 legacy preflight 与 CREATE 迁移表竞争导致误判，作为启动失败修复，不能放宽 legacy 检查。所有角色在开始服务前完成迁移。
5. **读限额与终止**：百万行对象流用低 maxResultRows/maxResultBytes 触发限额，迭代能提前释放；相较单行大小，新增 RSS 不得接近完整结果大小。递归聚合设置 100ms timeout，父调用在 500ms 内拒绝、旧 worker 在 2 秒内 exit、替补 5 秒内可读；重复 20 次后 active worker 数回到池容量、pending=0。不满足即阻断硬取消支持声明。
6. **长读与 checkpoint**：持有读 snapshot 同时完成 1000 个写事务，确认 reader 不阻断 WAL writer；记录 WAL 增长；return/close reader 后，在测试专属停写阶段执行 checkpoint，确认可回收。不得在生产 close 强制 truncate 作为“修复”。
7. **实际服务**：从 CJS 发布布局启动 Bun daemon，并单独启动 gateway（避免端口冲突）；先默认三库，再 role URL 映射到同库，执行摄入→查询→session-search→spend；正常退出后重新启动校验。性能记录吞吐与 p50/p95/p99，对比 Bun+turso 同工作负载；首版不承诺更快，但任何正确性/取消/预算断言失败都不发布。

## 9. 实施提交顺序

每步形成新提交，不能把本规格视为执行 git commit 的授权。

1. **配置与契约测试**：加入 resolver、错误码、Node/Bun runtime guard 测试；生产 sqlite 分派尚不打开，现有默认路径保持；验证 configuration/local/remote 基线。
2. **Statement 与值兼容层**：新增 sqlite 模块但不接入生产分派，完成 memory adapter、参数/结果转换与差分测试；加明确 Bun 类型依赖与 Node import smoke；验证所有第 4/5 节契约。
3. **事务与资源生命周期**：加入 gate/AsyncLocalStorage/句柄失效/关闭和 fault injection；验证三事务形态、withLocalTransaction/testing.ts、Drizzle savepoint，不允许父调用死锁。
4. **文件初始化与并发**：实现 WAL/preflight 钩子、readonly、BEGIN 重试、迁移竞争；运行文件两连接/多进程、legacy 字节保护、停机双向切换，确认无损后才允许下一步。
5. **分派与构建接入**：接入 createLocalDatabase，更新 CLI 全部相关 external 和 Bun 测试执行矩阵；从 shared dist 和 CLI bundle 分别跑读池、搜索 worker、Gateway。Gateway 构造无需分叉。
6. **全回归与发布门槛**：Node+turso 执行 `pnpm run typecheck && pnpm run lint && pnpm run test`；Bun 两引擎跑适用全套和隔离摄入；Node legacy 单独运行；CLI 构建/压测/取消验收。运行时迁移分支合并后重复产物验证，不能只凭源码测试通过。

## 10. 风险、待验证项与切换操作

设计选择已固定；以下是可测发布门槛，不留给实施者凭猜测选 API：

- **Bun worker 强制结束**（部分验证，仍为门槛）：1.4.2 的 memory worker 执行 2000 万步递归 SUM，开始 100ms 后调用 terminate，约 1403ms 后才返回；不能据此宣称能立即中断或满足任意长查询上限。文件 WAL 读锁释放、较长聚合、替补启动须按 8.3.5 验证。失败则保持默认 Turso，不将 sqlite 标为生产可用；另立取消机制设计，不临时引入未经评审的 FFI/RPC。
- **文件互操作的写入与反向切换**（待验证）：已知能打开不代表任意 WAL 状态互通；用受控副本做 Turso 完全关闭→Bun 写/关闭→Turso 重开，含迁移日志、int64、外键、压缩 IO。任何不一致均阻断原地切换声明。
- **Bun 1.4.0 与 1.4.2、Linux 与 macOS**（待验证）：类型源码为 1.4.2，必须实际验证最低版本的 declaredTypes、iterator.return、close(true)、error code 和打包 worker；缺 API 时不得猜测私有替代，先提高明确最低版本并更新规格/测试。
- **绑定记忆**（已发现差异）：Bun 1.4.2 部分命名对象更新会清空其他槽，Turso 会保留；4.3 已规定 wrapper 合并记忆，必须加入差分回归，不能依赖 native 的默认行为。声明支持的输入子集以外保持显式错误。
- **同步执行与内存**：主线程 get/all/raw-pluck iterate 会物化或阻塞；只有对象 iterate 保持有界消费。不给它们虚假的硬超时保证，不更换整个执行架构来掩盖差异。
- **native 依赖仍在**：Drizzle 的 tursodatabase/database 入口自身静态 import Turso，sqlite 选项不是“完全不安装/不加载 NAPI”的承诺；移除 native 依赖属于后续不同任务。
- **锁饥饿和迁移长事务**：单写者无公平性保证，5 秒预算可能失败；缩短业务事务、先离线完成长迁移再启动多个服务。不得通过自动重放任意 callback 修复。

切换流程：停止 server、gateway、CLI daemon 和所有 worker/维护写者；等待实际进程退出，按现有备份要求保存主库及 WAL/SHM 和 `PERIFUSE_HOME` 密钥文件。保持相同路径，用 Bun 启动且设置 `PERIFUSE_ENGINE=sqlite`，确认迁移/读写/搜索/扣账后开放流量。回退也必须先停所有进程；通过反向切换验收后才能直接改回 turso，否则恢复停机备份（这会丢弃备份后写入，需明确接受）。不自动删除 WAL、不重建盐/加密 key、不把旧 legacy 库直接当当前 schema 接管。

## 实施状态（2026-10-11）

状态：**已实施并通过核心验收**。本节为实施后记录；与上文契约冲突时以规格为准，有意偏离与遗留项在此显式列出。

### 实现落点

| 区域 | 落点 |
| --- | --- |
| 分派与配置 | `db/connection-config.ts`（`resolveLocalEngine`）、`db/local.ts`（remote → sqlite → turso；`assertSqliteRuntime` 前置于建目录/开文件；迁移与 WAL/preflight 钩子）、`db/errors.ts` |
| 引擎适配 | `db/sqlite.ts`、`db/sqlite-native.ts`、`db/sqlite-statement.ts`、`db/sqlite-transaction.ts`（FifoGate 单连接串行、AsyncLocalStorage 事务作用域、BEGIN 重试预算、惰性 `import("bun:sqlite")` + 版本 guard） |
| 打包 | `packages/cli/build.mjs` 三处 esbuild 均以 `bun:sqlite` 为 external；产物保留运行时 `import("bun:sqlite")`（探针于 `packages/cli/test/sqlite-engine.test.ts`） |
| 测试（新增） | shared `db/sqlite*.test.ts` × 5；`gateway/test/sqlite-engine.test.ts`；`cli/test/sqlite-engine.test.ts`；`shared/scripts/sqlite-read-pool-smoke.ts` |

### 与规格的有意偏离

1. **不添加 `@types/bun`、tsconfig `types` 保持 `["node"]`**（规格 §3.1）：实现以非字面量 `import(BUN_SQLITE_MODULE)` 加载，TypeScript 永不解析 `bun:sqlite`；native 形状由结构化接口 `BunSqliteModule` 描述，运行时由 guard 与测试验证。加 `bun` types 会把 Bun 全局引入 Node 目标的编译面，与"shared 保持 Node 可编译"冲突。
2. **测试文件落在仓库既有目录**：`packages/gateway/test/`、`packages/cli/test/`（规格写作 `src/__tests__/`）。CLI 套件为 `node:test` API、由 `bun test test/` 执行。
3. **`isSqliteDatabase` 由 `db/local.ts` 再导出**：引擎断言（gateway 测试）与诊断需要；此前仅模块内部使用。
4. **Bun 侧 vitest 固定 `pool: forks`**：`vmThreads` 实测不可用——VM 上下文内 `import("bun:sqlite")` 抛 `The property 'exportNames.default' is duplicated`（`ERR_INVALID_ARG_VALUE`），任何 sqlite 代码无法运行。
5. **压力验收为仓库精简用例**：`PERIFUSE_SQLITE_PRESSURE=1` 门控的并发用例（已跑通）；规格 §8.3 的七场景完整矩阵未实现、未执行。

### 验收矩阵（实际执行，2026-10-11）

| 矩阵 | 命令 | 结果 |
| --- | --- | --- |
| Node + Turso 全仓回归 | `pnpm run test`（含 `test:ingestion`） | **EXIT=0**：1,097 passed / 47 skipped / 0 failed（shared 303+42skip、gateway 143+4skip、server 345+1skip、cli 16、web 92、mcp 14、隔离摄入 184） |
| Bun + sqlite `src/db` 全套 | `bun --bun ./node_modules/vitest/vitest.mjs run src/db`（forks） | 81 passed / 5 failed / 1 skipped；5 失败全部在 `legacy-migration.test.ts`（Node 专属作业，multiprocess_wal 与 Bun 不兼容）；`remote.test.ts` 文件加载失败（zod 互操作） |
| Bun + sqlite 专属套件 | `... run src/db/sqlite` | 43 passed / 1 skipped；`PERIFUSE_SQLITE_PRESSURE=1 ... sqlite-concurrency` → 8/8 |
| Bun + sqlite server 侧 | `PERIFUSE_ENGINE=sqlite ... run src/server/session-search src/server/adapters/sqlite-read-pool.test.ts` | session-search/backfill/context/extraction/worker-source/lifecycle **22 passed**（含 worker 启停与失败恢复）；`sqlite-read-pool.test.ts`、`query.test.ts` 加载失败（同 zod 互操作），改由下条覆盖 |
| Bun + sqlite 读池冒烟 | `PERIFUSE_ENGINE=sqlite bun run scripts/sqlite-read-pool-smoke.ts` | OK：只读 worker、测试写连接并存、RESULT_LIMIT、超时后 worker 替换与排空 |
| Bun + sqlite Gateway | `PERIFUSE_ENGINE=sqlite bun --bun ... run`（全 22 文件）+ 新增 `test/sqlite-engine.test.ts` | 138 passed / 9 failed；9 个失败在 `proxy-stream-lifecycle`（8）与 `telemetry-bounds`（1）——**同一失败在 Bun+turso 下复现、Node 下 11/11 通过**，判定为 Bun×vitest 工具链差异而非引擎差异；新增文件 4/4（Node 下正确 skip） |
| Bun + sqlite CLI（常驻） | `bun test test/` | 16/16（12 既有 + 4 bundle 探针：external 保留、Node 默认引擎可用、Node sqlite 先于 I/O 拒绝、Bun 真实文件往返） |
| Bun + sqlite/turso daemon e2e | `PERIFUSE_SQLITE_E2E=1 bun test test/sqlite-engine.test.ts` | 7/7：临时 HOME 下 `start/status/stop` 双引擎各 ~0.9s；Node 启动 `PERIFUSE_ENGINE=sqlite` 退出码 1、零 `.db` 文件、日志含 `PERIFUSE_ENGINE=sqlite requires Bun`（同时证明 daemon 继承 CLI 环境） |

### 遗留与未验证

- 规格 §8.3 七场景压力矩阵（共库 6 万事务、事件循环心跳、隔离持久性、迁移竞争、读限额终止、长读 checkpoint、实际服务吞吐）**未执行**；仓库内仅有精简压力用例。
- `bun:sqlite` ↔ Turso 就地切换的完整受控验收未在最终实现上重跑（recon 阶段已在 `/tmp` 受控副本验证双向读写与 WAL 崩溃恢复）；切换流程按 §10 停服 + 备份执行。
- Docker 镜像未构建验证（Dockerfile 已含 bun runtime stage）；Bun 最低版 1.4.0 未实机验证（矩阵为 1.4.2）。
- 三个文件在 Bun 下无法经 vitest 加载（`remote.test.ts`、`query.test.ts`、`sqlite-read-pool.test.ts`）：`z.coerce` undefined 的 zod 命名导出互操作，属 vitest×Bun 加载器限制；由 Node 基线与读池冒烟脚本覆盖相应路径。
