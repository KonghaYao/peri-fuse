import { Activity, Fingerprint, GitBranch, Radio } from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import type { ErrorAnalysis } from "@/shared/lib/types";

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-2 border-danger/70 pl-3">
      <div className="font-mono text-xl font-semibold tracking-tight text-fg-primary">{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-fg-tertiary">{label}</div>
    </div>
  );
}

export function ErrorAnalysisRail({
  analysis,
  onSelectSignature,
}: {
  analysis: ErrorAnalysis;
  onSelectSignature: (signature: string) => void;
}) {
  const maxDaily = Math.max(...analysis.daily.map((item) => item.count), 1);

  return (
    <div className="space-y-6 p-4">
      <section>
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Radio className="h-3.5 w-3.5 text-danger" /> Incident window
        </div>
        <div className="grid grid-cols-3 gap-3 lg:grid-cols-1">
          <Metric label="Errors" value={analysis.summary.totalErrors.toLocaleString()} />
          <Metric
            label="Affected traces"
            value={analysis.summary.affectedTraces.toLocaleString()}
          />
          <Metric label="Signatures" value={analysis.summary.uniqueSignatures.toLocaleString()} />
        </div>
        {analysis.summary.lastSeen && (
          <p className="mt-3 text-xs text-fg-tertiary">
            Last seen {formatDateTime(analysis.summary.lastSeen)}
          </p>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Activity className="h-3.5 w-3.5" /> Error pulse
        </div>
        {analysis.daily.length === 0 ? (
          <p className="text-xs text-fg-tertiary">No errors in this window.</p>
        ) : (
          <div className="flex h-16 items-end gap-1 border-b border-line pb-1">
            {analysis.daily.map((item) => (
              <div
                key={item.date}
                className="min-w-1 flex-1 rounded-t-sm bg-danger/70 transition-colors hover:bg-danger"
                style={{ height: `${Math.max((item.count / maxDaily) * 100, 8)}%` }}
                title={`${item.date}: ${item.count} errors`}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
          <Fingerprint className="h-3.5 w-3.5" /> Error fingerprints
        </div>
        <div className="space-y-1.5">
          {analysis.groups.map((group) => (
            <button
              key={`${group.signature}-${group.lastSeen}`}
              type="button"
              onClick={() => onSelectSignature(group.signature)}
              className="group w-full rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-danger/20 hover:bg-danger-subtle focus-visible:border-danger"
            >
              <div className="line-clamp-2 font-mono text-[11px] leading-4 text-fg-primary">
                {group.signature}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-tertiary">
                <span className="font-semibold text-danger">{group.count} hits</span>
                <span>·</span>
                <span>{group.traceCount} traces</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {analysis.models.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-fg-secondary">
            <GitBranch className="h-3.5 w-3.5" /> Models involved
          </div>
          <div className="flex flex-wrap gap-1.5">
            {analysis.models.map((item) => (
              <span
                key={item.model}
                className="rounded border border-line bg-surface-inset px-2 py-1 font-mono text-[10px] text-fg-secondary"
              >
                {item.model} · {item.count}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
