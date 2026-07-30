# Spectra Design System

Peri-Fuse Lite 的自主设计语言。定位：现代 SaaS 可观测性后台 — 融合 Linear 的精致感与 Datadog 的数据密度。

---

## 1. 设计理念

- **Clarity over decoration** — 数据是主角，UI 是安静的画布
- **Density with hierarchy** — 高信息密度，但通过字号/色彩/间距建立清晰层级
- **Quiet motion** — 动效快速且有目的性，绝不阻塞操作
- **Dark-first** — 为开发者长时间注视优化，亮色模式同等精致

---

## 2. 色彩系统

### 2.1 品牌色

| Token | Light | Dark | 用途 |
|-------|-------|------|------|
| `--brand` | `oklch(0.55 0.19 262)` | `oklch(0.65 0.19 262)` | 主操作、活跃导航、链接 |
| `--brand-strong` | `oklch(0.48 0.20 262)` | `oklch(0.72 0.17 262)` | Hover 加深/亮 |
| `--brand-subtle` | `oklch(0.55 0.19 262 / 8%)` | `oklch(0.65 0.19 262 / 12%)` | 选中行、活跃背景 |
| `--brand-fg` | `#fff` | `oklch(0.14 0.02 262)` | 品牌色上的文字 |

品牌色相 262° (violet-indigo)：传达 AI/智能感，区别于常见蓝色后台。

### 2.2 语义色

| Token | Light | Dark | 用途 |
|-------|-------|------|------|
| `--success` | `oklch(0.55 0.15 155)` | `oklch(0.72 0.15 155)` | 成功状态、正常 level |
| `--warning` | `oklch(0.65 0.16 75)` | `oklch(0.78 0.14 80)` | 警告、WARNING level |
| `--danger` | `oklch(0.55 0.20 27)` | `oklch(0.68 0.19 25)` | 错误、删除、ERROR level |
| `--info` | `oklch(0.55 0.14 230)` | `oklch(0.70 0.13 230)` | 信息提示、DEBUG level |

### 2.3 中性色阶梯（冷调，微含蓝相 hue 250）

**Dark theme:**

| Token | Value | 用途 |
|-------|-------|------|
| `--bg-base` | `oklch(0.13 0.008 250)` | 页面底色 |
| `--bg-raised` | `oklch(0.16 0.008 250)` | 卡片/面板表面 |
| `--bg-overlay` | `oklch(0.19 0.010 250)` | 弹出层、下拉 |
| `--bg-inset` | `oklch(0.11 0.008 250)` | 输入框、代码块内凹面 |
| `--border-default` | `oklch(1 0 0 / 8%)` | 常规边框 |
| `--border-strong` | `oklch(1 0 0 / 14%)` | 强调边框、hover |
| `--text-primary` | `oklch(0.93 0.005 250)` | 主文字 |
| `--text-secondary` | `oklch(0.72 0.010 250)` | 次要文字 |
| `--text-tertiary` | `oklch(0.55 0.010 250)` | 辅助文字、placeholder |

**Light theme:**

| Token | Value | 用途 |
|-------|-------|------|
| `--bg-base` | `oklch(0.977 0.002 250)` | 页面底色 |
| `--bg-raised` | `oklch(1 0 0)` | 卡片/面板表面 |
| `--bg-overlay` | `oklch(1 0 0)` | 弹出层 |
| `--bg-inset` | `oklch(0.955 0.003 250)` | 内凹面 |
| `--border-default` | `oklch(0.20 0.01 250 / 10%)` | 常规边框 |
| `--border-strong` | `oklch(0.20 0.01 250 / 18%)` | 强调边框 |
| `--text-primary` | `oklch(0.18 0.010 250)` | 主文字 |
| `--text-secondary` | `oklch(0.42 0.010 250)` | 次要文字 |
| `--text-tertiary` | `oklch(0.58 0.008 250)` | 辅助文字 |

### 2.4 图表色板

按序使用，确保相邻色可区分：

```
chart-1: oklch(0.65 0.19 262)  — violet (brand)
chart-2: oklch(0.70 0.14 195)  — cyan
chart-3: oklch(0.75 0.14 80)   — amber
chart-4: oklch(0.68 0.17 330)  — pink
chart-5: oklch(0.72 0.15 155)  — green
chart-6: oklch(0.65 0.15 30)   — orange
```

---

## 3. 字体系统

### 3.1 字体栈

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", "Fira Code", monospace;
```

### 3.2 字号阶梯

| Token | Size | Line-height | 用途 |
|-------|------|-------------|------|
| `--text-2xl` | 24px | 32px | 页面大标题（少用） |
| `--text-xl` | 18px | 26px | 页面标题 |
| `--text-lg` | 15px | 22px | 卡片标题、区块标题 |
| `--text-md` | 13.5px | 20px | 正文、表格内容 |
| `--text-sm` | 12.5px | 18px | 次要内容、表格紧凑模式 |
| `--text-xs` | 11px | 16px | 标签、badge、时间戳 |

### 3.3 规则

- 标题：`font-weight: 600`，`letter-spacing: -0.02em`
- 正文：`font-weight: 400`
- 数值/ID/代码：始终使用 `--font-mono`，`font-feature-settings: "tnum"`（等宽数字）
- 大写标签：`font-size: 11px`，`letter-spacing: 0.06em`，`text-transform: uppercase`

---

## 4. 间距系统

基准网格 4px。常用值：

| Token | Value | 用途 |
|-------|-------|------|
| `--space-1` | 4px | 图标与文字间距 |
| `--space-2` | 8px | 紧凑元素间距 |
| `--space-3` | 12px | 列表项内边距 |
| `--space-4` | 16px | 卡片内边距（紧凑） |
| `--space-5` | 20px | 卡片内边距（常规） |
| `--space-6` | 24px | 区块间距 |
| `--space-8` | 32px | 页面级间距 |

页面内容区左右 padding: 24px；顶部 header 高度: 60px（含标题 + 副标题行）。

---

## 5. 圆角 / 阴影 / 边框

### 5.1 圆角

| Token | Value | 用途 |
|-------|-------|------|
| `--radius-sm` | 4px | Badge、小按钮 |
| `--radius-md` | 6px | 按钮、输入框 |
| `--radius-lg` | 8px | 卡片、弹窗 |
| `--radius-xl` | 12px | 大面板、dialog |
| `--radius-full` | 9999px | 头像、pill badge |

### 5.2 阴影（Dark 模式极少使用，靠 border 分层）

| Token | Value | 用途 |
|-------|-------|------|
| `--shadow-sm` | `0 1px 2px oklch(0 0 0 / 20%)` | 下拉菜单 |
| `--shadow-md` | `0 4px 12px oklch(0 0 0 / 30%)` | Dialog、slide-over |
| `--shadow-lg` | `0 8px 30px oklch(0 0 0 / 40%)` | Command palette |

Light 模式阴影更柔和：opacity 各降 50%。

### 5.3 边框

- 默认 1px `--border-default`
- 聚焦态：`2px ring --brand / 40%` + border 变为 brand
- 表格行间使用 `--border-default`，header 底部使用 `--border-strong`

---

## 6. 组件规范

### 6.1 按钮

| 变体 | 样式 |
|------|------|
| Primary | bg brand, text brand-fg, hover brand-strong, radius-md |
| Secondary | bg raised + border-default, text primary, hover border-strong + bg overlay |
| Ghost | transparent, hover bg-inset, text secondary → primary |
| Danger | bg danger, text white |

尺寸：`h-8 px-3 text-[13px]`（default）、`h-7 px-2.5 text-xs`（sm）、`h-9 px-4 text-sm`（lg）
所有按钮 `font-weight: 500`，`transition: 150ms`。

### 6.2 卡片

- bg `--bg-raised`，border `--border-default`，radius-lg
- padding: 20px
- 无阴影（dark）/ 极浅阴影（light: `--shadow-sm`）
- Card header 与 content 之间用 border 分隔

### 6.3 数据表格

- Header: `text-xs uppercase tracking-wide text-tertiary`，bg inset，sticky
- 行高：comfortable 44px / compact 34px
- 行 hover: `bg-overlay / 50%`
- 选中行: `bg brand-subtle` + 左侧 2px brand 边条
- 单元格: `text-md`，数值列右对齐 + mono 字体
- 边框: 仅水平行线 `border-default`

### 6.4 侧边导航

- 宽度: 240px 展开 / 64px 收起
- bg: `--bg-raised`，右侧 border
- 导航项: `h-8 radius-md px-3 text-[13px]`
- 活跃项: `bg brand-subtle` + `text brand` + 左侧 2px brand indicator
- 分组标签: `text-xs uppercase text-tertiary px-3 mt-4`
- 图标: 16px，stroke 1.75
- 项目切换器: 单行紧凑样式 `h-[34px]`，dot + 项目名 + 环境名水平排列，禁止两行布局
- 品牌图标: 纯色 brand 背景，禁止使用渐变

### 6.5 Badge

- 高度 20px，`radius-sm`，`text-xs font-medium`
- 变体: neutral (inset bg)、brand (brand-subtle bg + brand text)、success/warning/danger (对应 subtle bg + 对应 text)
- Level badge 使用 dot + text 组合

### 6.6 输入框

- `h-8 radius-md bg-inset border-default px-3 text-md`
- Focus: border-brand + ring
- Placeholder: `text-tertiary`
- 带图标时左 padding 32px

### 6.7 Stat Card（Dashboard）

- 结构: label (text-xs tertiary uppercase) → value (text-2xl mono semibold) → delta (text-xs + 语义色箭头)
- 左侧 3px 色条区分指标类别（可选）

---

## 7. 动效规范

| 场景 | Duration | Easing |
|------|----------|--------|
| Hover/focus 颜色变化 | 150ms | ease-out |
| 面板展开/折叠 | 200ms | cubic-bezier(0.4, 0, 0.2, 1) |
| Slide-over / Dialog 进入 | 250ms | cubic-bezier(0.32, 0.72, 0, 1) |
| Toast 进入 | 200ms | spring-like overshoot |
| 页面内容切换 | 150ms fade | ease-out |
| Skeleton shimmer | 1.5s loop | linear |

原则：
- 退出动效时长 = 进入的 60%
- 同一交互不超过 2 个属性动画
- `prefers-reduced-motion` 时禁用所有非必要动效

---

## 8. 布局规范

```
┌─────────────────────────────────────────────────────┐
│ Sidebar (240/64px)  │  Main Content    │ Peek Panel  │
│                     │  ┌─ Header (60px)│ (480px)     │
│  Brand (52px)       │  ├─ Toolbar      │             │
│  Project (34px)     │  ├─ Table        │ trace 详情  │
│  Nav Groups         │  └─ Pagination   │             │
│  ...                │                  │             │
│  Settings/Theme     │                  │             │
└─────────────────────────────────────────────────────┘
```

- 侧边栏与内容区等高，内容区独立滚动
- Page header 60px，sticky，包含标题 + 副标题（如结果计数）+ 页面级操作
- 表格工具栏（筛选器）位于 header 下方，非 sticky
- Peek panel: 480px 宽，点击表格行时从右侧推入（非 overlay，挤压内容区），展示 trace 摘要

### 页面职责划分

- **Traces/Sessions/Observations/Scores**: 纯工作流页面 — 专注筛选器 + 表格 + Peek 侧滑面板，不放统计卡片和图表
- **Dashboard**: 数据总览页面 — 统计卡片、图表、趋势分析集中于此

---

## 9. 图标

- 库: lucide-react
- 尺寸: 16px (导航/按钮)、14px (表格/badge)、20px (空状态)
- Stroke: 1.75（默认），导航可用 2
- 颜色跟随文字 token，活跃导航使用 brand

---

## 10. 空状态与加载

- Skeleton: `bg-overlay` + shimmer 动画，形状模拟真实内容
- 空状态: 居中图标 (20px, tertiary) + 一行描述 + 可选 CTA
- 错误状态: danger-subtle 背景条 + 图标 + 消息 + 重试按钮
