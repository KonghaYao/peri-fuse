/**
 * Minimal @peri/ui stand-in for Vitest. Avoids loading the full peri-studio barrel
 * (kobalte, xterm, mermaid, …) while still exercising page logic and fetch states.
 */
import { type Component, For, type JSX, Show, splitProps } from "solid-js";
import { vi } from "vitest";

type DivProps = JSX.HTMLAttributes<HTMLDivElement>;
type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string;
  size?: string;
  busy?: boolean;
  leadingIcon?: JSX.Element;
};

export const Button: Component<ButtonProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "busy",
    "leadingIcon",
    "class",
    "children",
  ]);
  return (
    <button type="button" class={local.class} {...rest}>
      {local.leadingIcon}
      {local.children}
    </button>
  );
};

export const Input: Component<JSX.InputHTMLAttributes<HTMLInputElement>> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <input class={local.class} {...rest} />;
};

export const Card: Component<DivProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div class={local.class} {...rest}>
      {local.children}
    </div>
  );
};

export const CardHeader: Component<DivProps> = Card;
export const CardTitle: Component<DivProps> = Card;
export const CardDescription: Component<DivProps> = Card;
export const CardContent: Component<DivProps> = Card;

export const Skeleton: Component<DivProps> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <div class={`ui-skeleton ${local.class ?? ""}`} {...rest} />;
};

export const PageHeaderShell: Component<{
  title: string;
  description?: string;
  class?: string;
}> = (props) => (
  <header class={props.class}>
    <h1>{props.title}</h1>
    {props.description ? <p>{props.description}</p> : null}
  </header>
);

export const MessageHost: Component = () => <div data-slot="message-host" />;

export const message = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

export const Dialog: Component<{
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: JSX.Element;
}> = (props) => (
  <Show when={props.open}>
    <div data-testid="dialog">{props.children}</div>
  </Show>
);

export const DialogContent: Component<DivProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div class={local.class} {...rest}>
      {local.children}
    </div>
  );
};

export const DialogHeader: Component<DivProps> = Card;
export const DialogTitle: Component<DivProps> = Card;
export const DialogDescription: Component<DivProps> = Card;

export const AlertDialog: Component<{
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: JSX.Element;
}> = (props) => (props.open ? <div data-testid="alert-dialog">{props.children}</div> : null);

export const AlertDialogContent: Component<DivProps> = DialogContent;
export const AlertDialogHeader: Component<DivProps> = Card;
export const AlertDialogTitle: Component<DivProps> = Card;
export const AlertDialogDescription: Component<DivProps> = Card;
export const AlertDialogFooter: Component<DivProps> = Card;

export const AlertDialogCancel: Component<ButtonProps> = Button;
export const AlertDialogAction: Component<ButtonProps> = Button;

type ChildrenProps = { children?: JSX.Element };

export const Badge: Component<ChildrenProps> = (props) => <span>{props.children}</span>;
export const StatChip: Component<{ label: string; value: string; icon?: JSX.Element }> = (
  props,
) => (
  <div data-testid="stat-chip">
    <span>{props.label}</span>
    <span>{props.value}</span>
  </div>
);

export const Statistic: Component<{
  title?: string;
  value?: number | string;
}> = (props) => (
  <div data-testid="statistic">
    <Show when={props.title}>
      <span>{props.title}</span>
    </Show>
    <span>{props.value}</span>
  </div>
);
export const ScrollArea: Component<ChildrenProps> = (props) => <div>{props.children}</div>;
export const Separator: Component<DivProps> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <div role="separator" class={local.class} {...rest} />;
};
export const InlineNotice: Component<ChildrenProps> = (props) => (
  <div role="alert">{props.children}</div>
);
export const Tabs: Component<ChildrenProps> = (props) => <div>{props.children}</div>;
export const TabsList: Component<ChildrenProps> = Tabs;
export const TabsTrigger: Component<ChildrenProps> = Tabs;
export const TabsContent: Component<ChildrenProps> = Tabs;
export const Table: Component<ChildrenProps> = (props) => <table>{props.children}</table>;
export const TableHeader: Component<ChildrenProps> = (props) => <thead>{props.children}</thead>;
export const TableBody: Component<ChildrenProps> = (props) => <tbody>{props.children}</tbody>;
export const TableRow: Component<ChildrenProps> = (props) => <tr>{props.children}</tr>;
export const TableHead: Component<ChildrenProps> = (props) => <th>{props.children}</th>;
export const TableCell: Component<ChildrenProps> = (props) => <td>{props.children}</td>;

export const MonitorTraceTurnTreeShell: Component<{
  tree?: JSX.Element;
  detail?: JSX.Element;
  showDetailPlaceholder?: boolean;
  class?: string;
  "data-testid"?: string;
}> = (props) => (
  <div data-testid={props["data-testid"] ?? "trace-workspace"} class={props.class}>
    <div data-testid="tree-pane">{props.tree}</div>
    <div data-testid="detail-pane">
      <Show when={!props.showDetailPlaceholder}>{props.detail}</Show>
    </div>
  </div>
);

export const Sheet: Component<{
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: JSX.Element;
}> = (props) => <Show when={props.open ?? true}>{props.children}</Show>;

export const SheetContent: Component<{
  side?: string;
  class?: string;
  children?: JSX.Element;
}> = (props) => (
  <div data-testid="trace-peek-drawer" class={props.class}>
    {props.children}
  </div>
);

export const SheetClose: Component<ButtonProps> = (props) => <Button {...props} />;

export const MonitorTraceTurnTree: Component<{
  observations?: Array<{ id: string; name?: string | null }>;
  onSelect?: (id: string) => void;
  onTraceRootSelect?: () => void;
  selectedId?: string | null;
  traceRoot?: { name: string };
}> = (props) => (
  <div data-testid="trace-tree">
    <Show when={props.traceRoot}>
      {(root) => (
        <button type="button" data-testid="monitor-trace-turn-tree-root" onClick={() => props.onTraceRootSelect?.()}>
          {root().name}
        </button>
      )}
    </Show>
    <For each={props.observations ?? []}>
      {(observation) => (
        <button
          type="button"
          data-testid={`monitor-trace-turn-node-${observation.id}`}
          onClick={() => props.onSelect?.(observation.id)}
        >
          {observation.name ?? observation.id}
        </button>
      )}
    </For>
  </div>
);

export const defaultIsNoiseObservation = () => false;
export const MonitorTimelineDialogShell: Component = () => <div />;
export const MonitorTimelineShell: Component = () => <div />;
export const IoTabsShell: Component<{
  renderPreview?: () => JSX.Element;
  renderInput: () => JSX.Element;
  renderOutput: () => JSX.Element;
  renderMetadata: () => JSX.Element;
}> = (props) => (
  <div data-testid="io-tabs-shell">
    <div data-testid="io-tab-input">{props.renderInput()}</div>
    <div data-testid="io-tab-output">{props.renderOutput()}</div>
    <div data-testid="io-tab-metadata">{props.renderMetadata()}</div>
  </div>
);

export const IoViewer: Component<{ data: unknown }> = (props) => {
  const value = () => {
    const data = props.data;
    return typeof data === "function" ? (data as () => unknown)() : data;
  };
  return (
    <div data-testid="io-viewer">
      {value() === null || value() === undefined
        ? "(empty)"
        : typeof value() === "object"
          ? JSON.stringify(value())
          : String(value())}
    </div>
  );
};
export const ScoreListShell: Component = () => <div />;
export const FilterInput: Component = () => <input />;
export const FilterSelect: Component = () => <select />;
export const DateFilterInput: Component = () => <input type="date" />;

const InlineFormRoot: Component<JSX.FormHTMLAttributes<HTMLFormElement>> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <form class={local.class} {...rest}>
      {local.children}
    </form>
  );
};

const InlineFormField: Component<DivProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <div class={local.class} {...rest}>
      {local.children}
    </div>
  );
};

const InlineFormActions: Component<DivProps> = InlineFormField;

export const InlineForm = Object.assign(InlineFormRoot, {
  Field: InlineFormField,
  Actions: InlineFormActions,
});
export const TableInlineError: Component = () => <div role="alert" />;
export const EmptyState: Component<{ title: string; variant?: string }> = (props) => (
  <div>{props.title}</div>
);
export const AutoRefreshIntervalControl: Component = () => <div />;
export const JsonTree: Component = () => <div />;
export const LoadingState: Component<{ label?: string }> = (props) => <div>{props.label}</div>;
export const LocalIsoDate: Component = () => <span>date</span>;
export const TruncatedIdCell: Component<{ value: string }> = (props) => <span>{props.value}</span>;
export const TokenUsageBadge: Component = () => <span>usage</span>;
export const LevelCountsDisplay: Component = () => <span>levels</span>;
export const IoPreviewCell: Component = () => <span>io</span>;
export const formatCountLabelAsLevel = (countLabel: string) =>
  countLabel.replace(/Count$/, "").toUpperCase();
export const monitorLevelSymbol = () => "•";
export const PaginationControls: Component = () => <div />;
type EnhancedDataTableColumnStub<T> = {
  id: string;
  header?: string;
  cell?: (row: T) => JSX.Element;
  accessor?: (row: T) => unknown;
};

export const EnhancedDataTable: Component<{
  data?: unknown[];
  columns?: EnhancedDataTableColumnStub<unknown>[];
  toolbar?: JSX.Element;
  rowKey?: (row: unknown, index: number) => string;
  pagination?: {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number) => void;
  };
}> = (props) => (
  <div
    data-table-rows={props.data?.length ?? 0}
    data-trace-rows={props.data?.length ?? 0}
    data-session-rows={props.data?.length ?? 0}
    data-has-toolbar={props.toolbar ? "1" : "0"}
  >
    {props.toolbar}
    <For each={props.data ?? []}>
      {(row, index) => (
        <div data-row-key={props.rowKey?.(row, index()) ?? String(index())}>
          <For each={props.columns ?? []}>
            {(column) => (
              <span data-column={column.id}>
                {column.cell
                  ? column.cell(row)
                  : String(column.accessor?.(row) ?? "")}
              </span>
            )}
          </For>
        </div>
      )}
    </For>
    <Show when={props.pagination}>
      {(pagination) => (
        <button
          type="button"
          data-testid="table-next-page"
          disabled={pagination().current * pagination().pageSize >= pagination().total}
          onClick={() => pagination().onChange(pagination().current + 1)}
        >
          Next page
        </button>
      )}
    </Show>
  </div>
);

const TableViewRoot: Component<{ class?: string; children?: JSX.Element }> = (props) => (
  <div data-slot="table-view" class={props.class}>
    {props.children}
  </div>
);

const TableViewToolbar: Component<{ children?: JSX.Element }> = (props) => (
  <div data-slot="table-view-toolbar">{props.children}</div>
);

const TableViewBody: Component<{ children?: JSX.Element }> = (props) => (
  <div data-slot="table-view-body">{props.children}</div>
);

const TableViewFooter: Component<{ children?: JSX.Element }> = (props) => (
  <div data-slot="table-view-footer">{props.children}</div>
);

type TableViewServerTableProps = {
  class?: string;
  data?: unknown[];
  columns?: EnhancedDataTableColumnStub<unknown>[];
  toolbar?: JSX.Element;
  rowKey?: (row: unknown, index: number) => string;
  showColumnToggle?: boolean;
  pagination?: {
    current: number;
    pageSize: number;
    total: number;
    onChange?: (page: number, pageSize: number) => void;
  };
};

const TableViewServerTable: Component<TableViewServerTableProps> = (props) => {
  const [local] = splitProps(props, [
    "class",
    "toolbar",
    "pagination",
    "showColumnToggle",
    "data",
    "columns",
    "rowKey",
  ]);
  const showToolbar = () => Boolean(local.showColumnToggle || local.toolbar);

  return (
    <TableViewRoot class={local.class}>
      <Show when={showToolbar()}>
        <TableViewToolbar>{local.toolbar}</TableViewToolbar>
      </Show>
      <TableViewBody>
        <EnhancedDataTable
          data={local.data}
          columns={local.columns}
          rowKey={local.rowKey}
          toolbar={undefined}
        />
      </TableViewBody>
      <Show when={local.pagination}>
        {(pagination) => (
          <TableViewFooter>
            <div data-slot="pagination-controls">
              <span>Total {pagination().total} items</span>
              <button
                type="button"
                data-testid="table-next-page"
                disabled={
                  pagination().current * pagination().pageSize >= pagination().total &&
                  !pagination().onChange
                }
                onClick={() => pagination().onChange?.(pagination().current + 1, pagination().pageSize)}
              >
                Next page
              </button>
            </div>
          </TableViewFooter>
        )}
      </Show>
    </TableViewRoot>
  );
};

export const TableView = Object.assign(TableViewRoot, {
  Toolbar: TableViewToolbar,
  Body: TableViewBody,
  Footer: TableViewFooter,
  ServerTable: TableViewServerTable,
});
export const TableLoadingRows: Component = () => <div data-loading-rows />;
export const BlockLoadingRows: Component<{ rows?: number }> = (props) => (
  <div data-block-loading-rows={props.rows ?? 4} role="status" />
);

export const PanelCard: Component<{
  title: string;
  description?: string;
  isEmpty?: boolean;
  emptyMessage?: string;
  children?: JSX.Element;
}> = (props) => (
  <section data-panel-card={props.title}>
    <h2>{props.title}</h2>
    {props.isEmpty ? <p>{props.emptyMessage ?? "empty"}</p> : props.children}
  </section>
);

export const StatusPill: Component<{ status: string }> = (props) => (
  <span data-status-pill={props.status}>{props.status}</span>
);

export type QueryHandle<T> = {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
};

export function resolveQueryState<T>(
  snapshot: QueryHandle<T>,
  isEmpty: (data: T) => boolean,
) {
  if (snapshot.data === undefined) {
    if (snapshot.error) {
      return { kind: "error" as const, error: snapshot.error, isFetching: snapshot.isFetching };
    }
    return { kind: "loading" as const, isFetching: snapshot.isFetching };
  }
  return {
    kind: "content" as const,
    data: snapshot.data,
    isEmpty: isEmpty(snapshot.data),
    staleError: snapshot.error ?? null,
    isFetching: snapshot.isFetching,
  };
}

export const QuerySection: Component<{
  label: string;
  query: QueryHandle<unknown>;
  isEmpty: (data: unknown) => boolean;
  loading: JSX.Element;
  empty: JSX.Element;
  children: (data: unknown) => JSX.Element;
}> = (props) => {
  const state = resolveQueryState(props.query, props.isEmpty);
  if (state.kind === "loading") {
    return (
      <div role="status" aria-label={`Loading ${props.label}`}>{props.loading}</div>
    );
  }
  if (state.kind === "error") {
    return (
      <div role="alert">
        <p>{`Could not load ${props.label}.`}</p>
        <button
          type="button"
          aria-label={`Retry ${props.label}`}
          disabled={props.query.isFetching}
          onClick={() => void props.query.refetch()}
        >
          {props.query.isFetching ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }
  return (
    <div aria-busy={state.isFetching}>
      {state.staleError && (
        <div role="alert">
          <p>{`Could not refresh ${props.label}; showing previous data.`}</p>
          <button
            type="button"
            aria-label={`Retry ${props.label}`}
            disabled={props.query.isFetching}
            onClick={() => void props.query.refetch()}
          >
            {props.query.isFetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {state.isFetching && !state.staleError && (
        <span role="status">Refreshing {props.label}</span>
      )}
      {state.isEmpty ? props.empty : props.children(state.data)}
    </div>
  );
};

const ChartPart: Component<ChildrenProps> = (props) => <div>{props.children}</div>;

export const Chart = {
  Cartesian: ChartPart,
  Bars: ChartPart,
  Line: ChartPart,
  BarsHorizontal: ChartPart,
  Donut: ChartPart,
  Legend: ChartPart,
};

export const ACTIVITY_CHART_HEIGHT = 200;
export const DUAL_AXIS_CHART_MARGIN = { top: 8, right: 8, bottom: 24, left: 40 };
export const formatChartCompact = (value: number) => String(value);

export const MonitorObservationTypeBadge: Component<{ type: string }> = (props) => (
  <span>{props.type}</span>
);
export const MonitorObservationLevelBadge: Component<{ level: string }> = (props) => (
  <span>{props.level}</span>
);
