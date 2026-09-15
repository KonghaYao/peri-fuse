/**
 * Gateway Model Deployments management page.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  BlockLoadingRows,
  Button,
  message,
  PageHeaderShell,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableView,
} from "@peri/ui";
import { AlertTriangle, Loader2, Pencil, Plus, Power, Trash2 } from "lucide-solid";
import { type Component, createSignal, Show } from "solid-js";
import { GatewayProjectGate } from "@/features/gateway/components/gateway-project-gate";
import { ModelDialog } from "@/features/gateway/components/model-dialog";
import {
  useGwCreateModelMutation,
  useGwDeleteModelMutation,
  useGwModelsQuery,
  useGwUpdateModelMutation,
} from "@/shared/hooks/gateway-queries";
import type { ModelDeployment } from "@/shared/lib/gateway-api";

const ModelsContent: Component = () => {
  const modelsQuery = useGwModelsQuery();
  const createModel = useGwCreateModelMutation();
  const updateModel = useGwUpdateModelMutation();
  const deleteModel = useGwDeleteModelMutation();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editing, setEditing] = createSignal<ModelDeployment | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<ModelDeployment | null>(null);

  const deployments = () => modelsQuery.data ?? [];

  const handleSubmit = (body: Parameters<typeof createModel.mutate>[0]) => {
    const current = editing();
    if (current) {
      void updateModel
        .mutateAsync({ id: current.id, body })
        .then(() => {
          setDialogOpen(false);
          setEditing(null);
          message.success("Deployment updated");
        })
        .catch((err) => message.error(err instanceof Error ? err.message : "Update failed"));
      return;
    }
    void createModel
      .mutateAsync(body)
      .then(() => {
        setDialogOpen(false);
        message.success("Deployment created");
      })
      .catch((err) => message.error(err instanceof Error ? err.message : "Create failed"));
  };

  const toggleEnabled = (d: ModelDeployment) => {
    void updateModel
      .mutateAsync({ id: d.id, body: { isEnabled: !d.isEnabled } })
      .then(() => message.success(d.isEnabled ? "Deployment disabled" : "Deployment enabled"))
      .catch((err) => message.error(err instanceof Error ? err.message : "Update failed"));
  };

  const confirmDelete = () => {
    const target = deleteTarget();
    if (!target || deleteModel.isPending) return;
    void deleteModel
      .mutateAsync(target.id)
      .then(() => {
        setDeleteTarget(null);
        message.success("Deployment deleted");
      })
      .catch((err) => message.error(err instanceof Error ? err.message : "Delete failed"));
  };

  return (
    <div class="p-24">
      <div class="mb-16 flex justify-end">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          leadingIcon={<Plus class="h-16 w-16" size={16} />}
        >
          Add Deployment
        </Button>
      </div>

      <Show
        when={modelsQuery.isPending}
        fallback={
          <Show
            when={modelsQuery.isError}
            fallback={
              <Show
                when={deployments().length > 0}
                fallback={
                  <p class="py-32 text-center text-sm text-fg-tertiary">
                    No model deployments. Map a model alias to a provider.
                  </p>
                }
              >
                <TableView>
                  <TableView.Body>
                    <Table wrapperClass="min-h-0 flex-1">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Model Alias</TableHead>
                          <TableHead>Provider Model</TableHead>
                          <TableHead>Provider</TableHead>
                          <TableHead class="hidden md:table-cell">Pricing ($/1M)</TableHead>
                          <TableHead>Enabled</TableHead>
                          <TableHead class="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deployments().map((d) => (
                          <TableRow>
                            <TableCell class="font-mono text-[13px] font-medium text-fg-primary">
                              {d.modelName}
                            </TableCell>
                            <TableCell class="font-mono text-xs text-fg-secondary">
                              {d.providerModel}
                            </TableCell>
                            <TableCell class="text-fg-secondary">
                              {d.provider ? (
                                <>
                                  {d.provider.name}
                                  <span class="ml-6 rounded bg-muted px-6 py-2 font-mono text-[10px] uppercase text-fg-tertiary">
                                    {d.provider.type}
                                  </span>
                                </>
                              ) : (
                                <Badge tone="warning" title="Select a provider when editing">
                                  <AlertTriangle class="h-14 w-14" size={14} />
                                  Provider unavailable
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell class="hidden text-xs text-fg-tertiary md:table-cell">
                              {d.modelInfo?.inputPrice != null || d.modelInfo?.outputPrice != null
                                ? `${d.modelInfo?.inputPrice ?? "?"} / ${d.modelInfo?.outputPrice ?? "?"}`
                                : "—"}
                            </TableCell>
                            <TableCell>
                              <span
                                class={`inline-flex items-center rounded-full border px-8 py-2 text-[11px] font-medium ${
                                  d.isEnabled
                                    ? "border-success/30 bg-success-subtle text-success"
                                    : "border-border bg-muted text-fg-tertiary"
                                }`}
                              >
                                {d.isEnabled ? "Yes" : "No"}
                              </span>
                            </TableCell>
                            <TableCell>
                              <div class="flex items-center justify-end gap-4">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title={d.isEnabled ? "Disable" : "Enable"}
                                  onClick={() => toggleEnabled(d)}
                                >
                                  <Power
                                    class={`h-14 w-14 ${d.isEnabled ? "text-success" : "text-fg-tertiary"}`}
                                    size={14}
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
                                  <Pencil class="h-14 w-14" size={14} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Delete"
                                  onClick={() => setDeleteTarget(d)}
                                >
                                  <Trash2 class="h-14 w-14 text-danger" size={14} />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableView.Body>
                </TableView>
              </Show>
            }
          >
            <div
              role="alert"
              class="flex items-center justify-between rounded-md border border-danger/30 bg-danger-subtle px-12 py-8"
            >
              <p class="text-sm text-danger">
                {modelsQuery.error instanceof Error
                  ? modelsQuery.error.message
                  : "Failed to load deployments"}
              </p>
              <Button
                variant="default"
                size="sm"
                onClick={() => void modelsQuery.refetch()}
                disabled={modelsQuery.isFetching}
              >
                Retry
              </Button>
            </div>
          </Show>
        }
      >
        <BlockLoadingRows />
      </Show>

      <AlertDialog
        open={deleteTarget() !== null}
        onOpenChange={(open) => !open && !deleteModel.isPending && setDeleteTarget(null)}
      >
        <AlertDialogContent class="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete deployment?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the model route and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <dl class="space-y-8 rounded-md border border-border bg-surface-inset p-12 text-sm">
            <div class="flex items-start justify-between gap-16">
              <dt class="text-fg-tertiary">Model Alias</dt>
              <dd class="break-all text-right font-mono text-fg-primary">
                {deleteTarget()?.modelName || "(unnamed deployment)"}
              </dd>
            </div>
            <div class="flex items-start justify-between gap-16">
              <dt class="text-fg-tertiary">Provider Model</dt>
              <dd class="break-all text-right font-mono text-fg-primary">
                {deleteTarget()?.providerModel || "(unknown provider model)"}
              </dd>
            </div>
            <div class="flex items-start justify-between gap-16">
              <dt class="text-fg-tertiary">Provider</dt>
              <dd class="break-all text-right text-fg-primary">
                {deleteTarget()?.provider?.name ?? "Provider unavailable"}
              </dd>
            </div>
          </dl>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteModel.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              disabled={deleteModel.isPending}
              onClick={confirmDelete}
            >
              <Show when={deleteModel.isPending}>
                <Loader2 class="h-16 w-16 animate-spin" size={16} />
              </Show>
              Delete deployment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ModelDialog
        open={dialogOpen()}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        deployment={editing()}
        onSubmit={handleSubmit}
        isPending={createModel.isPending || updateModel.isPending}
      />
    </div>
  );
};

export const GatewayModelsPage: Component = () => (
  <GatewayProjectGate title="Models" description="Model alias → provider deployments.">
    <div class="flex h-full flex-col">
      <PageHeaderShell title="Models" description="Model alias → provider deployments." />
      <div class="flex-1 overflow-y-auto">
        <ModelsContent />
      </div>
    </div>
  </GatewayProjectGate>
);
