/**
 * Minimal @peri/ui stand-in for Vitest. Avoids loading the full peri-studio barrel
 * (kobalte, xterm, mermaid, …) while still exercising page logic and fetch states.
 */
import { type Component, type JSX, Show, splitProps } from "solid-js";
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
export const ScrollArea: Component<ChildrenProps> = (props) => <div>{props.children}</div>;
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
}> = (props) => (
  <div data-testid="trace-workspace">
    <div data-testid="tree-pane">{props.tree}</div>
    <div data-testid="detail-pane">{props.detail}</div>
  </div>
);

export const MonitorTraceTurnTree: Component = () => <div data-testid="trace-tree" />;
export const MonitorTimelineDialogShell: Component = () => <div />;
export const MonitorTimelineShell: Component = () => <div />;
export const IoTabsShell: Component = () => <div />;
export const IoViewer: Component = () => <div />;
export const ScoreListShell: Component = () => <div />;
export const FilterInput: Component = () => <input />;
export const FilterSelect: Component = () => <select />;
export const DateFilterInput: Component = () => <input type="date" />;
export const TableInlineError: Component = () => <div role="alert" />;
export const EmptyState: Component<{ title: string }> = (props) => <div>{props.title}</div>;
export const AutoRefreshIntervalControl: Component = () => <div />;
export const JsonTree: Component = () => <div />;
export const LoadingState: Component<{ label?: string }> = (props) => <div>{props.label}</div>;
export const LocalIsoDate: Component = () => <span>date</span>;
export const TruncatedIdCell: Component<{ value: string }> = (props) => <span>{props.value}</span>;
export const TokenUsageBadge: Component = () => <span>usage</span>;
export const LevelCountsDisplay: Component = () => <span>levels</span>;
export const IoPreviewCell: Component = () => <span>io</span>;
export const PaginationControls: Component = () => <div />;
export const EnhancedDataTable: Component<{
  data?: unknown[];
  toolbar?: JSX.Element;
}> = (props) => (
  <div data-trace-rows={props.data?.length ?? 0} data-has-toolbar={props.toolbar ? "1" : "0"} />
);
export const TableLoadingRows: Component = () => <div data-loading-rows />;
export const MonitorObservationTypeBadge: Component<{ type: string }> = (props) => (
  <span>{props.type}</span>
);
export const MonitorObservationLevelBadge: Component<{ level: string }> = (props) => (
  <span>{props.level}</span>
);
