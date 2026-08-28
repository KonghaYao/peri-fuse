/**
 * Gateway Model Deployments management page.
 */
import { AlertTriangle, Loader2, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { ModelDialog } from "@/features/gateway/components/model-dialog";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { toast } from "@/shared/components/toast";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent } from "@/shared/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import {
  useGwCreateModelMutation,
  useGwDeleteModelMutation,
  useGwModelsQuery,
  useGwUpdateModelMutation,
} from "@/shared/hooks/gateway-queries";
import type { ModelDeployment } from "@/shared/lib/gateway-api";

function ModelsContent() {
  const modelsQuery = useGwModelsQuery();
  const createModel = useGwCreateModelMutation();
  const updateModel = useGwUpdateModelMutation();
  const deleteModel = useGwDeleteModelMutation();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ModelDeployment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelDeployment | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const deleteOpenerRef = useRef<HTMLButtonElement | null>(null);

  const deployments = modelsQuery.data ?? [];

  const handleSubmit = (body: Parameters<typeof createModel.mutate>[0]) => {
    if (editing) {
      updateModel.mutate(
        { id: editing.id, body },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditing(null);
            toast.success("Deployment updated");
          },
          onError: (err) => toast.error("Update failed", err.message),
        },
      );
    } else {
      createModel.mutate(body, {
        onSuccess: () => {
          setDialogOpen(false);
          toast.success("Deployment created");
        },
        onError: (err) => toast.error("Create failed", err.message),
      });
    }
  };

  const toggleEnabled = (d: ModelDeployment) => {
    updateModel.mutate(
      { id: d.id, body: { isEnabled: !d.isEnabled } },
      {
        onSuccess: () => toast.success(d.isEnabled ? "Deployment disabled" : "Deployment enabled"),
        onError: (err) => toast.error("Update failed", err.message),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleteTarget || deleteModel.isPending) return;
    const targetId = deleteTarget.id;
    deleteModel.mutate(targetId, {
      onSuccess: () => {
        deleteOpenerRef.current = null;
        setDeleteTarget(null);
        toast.success("Deployment deleted");
      },
      onError: (err) => toast.error("Delete failed", err.message),
    });
  };

  if (modelsQuery.isLoading) return <LoadingRows />;
  if (modelsQuery.error) return <ErrorState error={modelsQuery.error} />;

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-end">
        <Button
          ref={addButtonRef}
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Add Deployment
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {deployments.length === 0 ? (
            <EmptyState message="No model deployments. Map a model alias to a provider." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                  <th className="px-4 py-3">Model Alias</th>
                  <th className="px-4 py-3">Provider Model</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="hidden px-4 py-3 md:table-cell">Pricing ($/1M)</th>
                  <th className="px-4 py-3">Enabled</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-border/50 transition-colors hover:bg-surface-overlay/40"
                  >
                    <td className="px-4 py-3 font-mono text-[13px] font-medium text-fg-primary">
                      {d.modelName}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-fg-secondary">
                      {d.providerModel}
                    </td>
                    <td className="px-4 py-3 text-fg-secondary">
                      {d.provider ? (
                        <>
                          {d.provider.name}
                          <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-fg-tertiary">
                            {d.provider.type}
                          </span>
                        </>
                      ) : (
                        <Badge
                          variant="warning"
                          title="Select a provider when editing this deployment"
                        >
                          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
                          Provider unavailable
                        </Badge>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-fg-tertiary md:table-cell">
                      {d.modelInfo?.inputPrice != null || d.modelInfo?.outputPrice != null
                        ? `${d.modelInfo?.inputPrice ?? "?"} / ${d.modelInfo?.outputPrice ?? "?"}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          d.isEnabled
                            ? "border-success/30 bg-success-subtle text-success"
                            : "border-border bg-muted text-fg-tertiary"
                        }`}
                      >
                        {d.isEnabled ? "Yes" : "No"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          title={d.isEnabled ? "Disable" : "Enable"}
                          onClick={() => toggleEnabled(d)}
                        >
                          <Power
                            className={`h-3.5 w-3.5 ${d.isEnabled ? "text-success" : "text-fg-tertiary"}`}
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Edit"
                          onClick={() => {
                            setEditing(d);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Delete"
                          onClick={(event) => {
                            deleteOpenerRef.current = event.currentTarget;
                            setDeleteTarget(d);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteModel.isPending) setDeleteTarget(null);
        }}
      >
        <DialogContent
          className="max-w-sm"
          hideClose={deleteModel.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const opener = deleteOpenerRef.current;
            if (opener?.isConnected) opener.focus();
            else addButtonRef.current?.focus();
            deleteOpenerRef.current = null;
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete deployment?</DialogTitle>
            <DialogDescription>
              This removes the model route and cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <dl className="space-y-2 rounded-md border border-border bg-surface-inset p-3 text-sm">
            <div className="flex items-start justify-between gap-4">
              <dt className="text-fg-tertiary">Model Alias</dt>
              <dd className="break-all text-right font-mono text-fg-primary">
                {deleteTarget?.modelName || "(unnamed deployment)"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-fg-tertiary">Provider Model</dt>
              <dd className="break-all text-right font-mono text-fg-primary">
                {deleteTarget?.providerModel || "(unknown provider model)"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-fg-tertiary">Provider</dt>
              <dd className="break-all text-right text-fg-primary">
                {deleteTarget?.provider?.name ?? "Provider unavailable"}
              </dd>
            </div>
          </dl>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={deleteModel.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteModel.isPending}
              onClick={confirmDelete}
            >
              {deleteModel.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}
              Delete deployment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ModelDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        deployment={editing}
        onSubmit={handleSubmit}
        isPending={createModel.isPending || updateModel.isPending}
      />
    </div>
  );
}

export function GatewayModelsPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Models" description="Model alias → provider deployments." />
      <div className="flex-1 overflow-y-auto">
        <ModelsContent />
      </div>
    </div>
  );
}
