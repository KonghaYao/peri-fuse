/**
 * Minimal toast notification system (Spectra).
 *
 * Zero-dependency, module-level store — call `toast.success("...")` from
 * anywhere (no provider wiring needed), render <Toaster /> once in main.tsx.
 * Auto-dismisses after 4s; newest toasts stack at the bottom-right.
 */
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@/shared/lib/utils";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
}

const DURATION_MS = 4000;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): ToastItem[] {
  return items;
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function toast(opts: {
  variant?: ToastVariant;
  title: string;
  description?: string;
}): number {
  const id = nextId++;
  const item: ToastItem = { id, variant: opts.variant ?? "info", ...opts };
  items = [...items.slice(-3), item]; // keep at most 4 visible
  emit();
  window.setTimeout(() => dismissToast(id), DURATION_MS);
  return id;
}

toast.success = (title: string, description?: string) =>
  toast({ variant: "success", title, description });
toast.error = (title: string, description?: string) =>
  toast({ variant: "error", title, description });
toast.info = (title: string, description?: string) =>
  toast({ variant: "info", title, description });
toast.warning = (title: string, description?: string) =>
  toast({ variant: "warning", title, description });

const variantStyles: Record<ToastVariant, { icon: typeof Info; accent: string }> = {
  success: { icon: CheckCircle2, accent: "text-success" },
  error: { icon: XCircle, accent: "text-danger" },
  warning: { icon: TriangleAlert, accent: "text-warning" },
  info: { icon: Info, accent: "text-info" },
};

/** Mount once near the app root. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const { icon: Icon, accent } = variantStyles[t.variant];
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-popover p-3 shadow-md",
              "animate-[spectra-toast-in_200ms_cubic-bezier(0.21,1.02,0.73,1)]",
            )}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", accent)} />
            <div className="min-w-0 flex-1">
              <p className="text-md font-medium leading-5 text-fg-primary">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-sm leading-[18px] text-fg-secondary">{t.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="shrink-0 rounded-sm p-0.5 text-fg-tertiary transition-colors hover:text-fg-primary"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
