import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/shared/components/ui/button";
import { useProjectContext } from "@/shared/store/project";
import { initializeProjectContext } from "@/shared/store/project-initialization";

export function ProjectBootstrap({ children }: { children: ReactNode }) {
  const context = useProjectContext();
  const initialization = useQuery({
    queryKey: ["project-initialization"],
    queryFn: initializeProjectContext,
    staleTime: Infinity,
    retry: false,
  });

  if (initialization.isPending || (!context && initialization.isFetching)) {
    return (
      <div
        className="flex min-h-screen items-center justify-center gap-3 bg-background text-fg-secondary"
        role="status"
      >
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Opening your project…</span>
      </div>
    );
  }

  if (initialization.isError || !context) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6" role="alert">
          <AlertCircle className="mb-3 h-6 w-6 text-danger" />
          <h1 className="mb-2 text-lg font-semibold">Could not open your project</h1>
          <p className="mb-4 text-sm text-fg-secondary">
            {initialization.error?.message ?? "Your project credentials need to be refreshed."}
          </p>
          <Button
            onClick={() => void initialization.refetch()}
            disabled={initialization.isFetching}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return children;
}
