import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";

/**
 * Renders an arbitrary JSON value (trace/observation input/output/metadata).
 * Falls back to a plain string block for non-object values.
 */
export function JsonViewer({
  data,
  collapsed = 2,
}: {
  data: unknown;
  collapsed?: number | boolean;
}) {
  if (data === null || data === undefined) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        (empty)
      </div>
    );
  }

  // react18-json-view expects an object/array for `src`; render primitives as
  // a simple preformatted block.
  if (typeof data !== "object") {
    return (
      <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
        {String(data)}
      </pre>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
      <JsonView
        src={data as Record<string, unknown> | unknown[]}
        collapsed={collapsed}
        enableClipboard={false}
        displaySize={false}
        theme="default"
      />
    </div>
  );
}
