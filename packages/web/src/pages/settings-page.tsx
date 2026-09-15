import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  message,
  PageHeaderShell,
  Skeleton,
} from "@peri/ui";
import { AlertTriangle, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-solid";
import { type Component, createSignal, For, Show } from "solid-js";
import {
  useCreateKeyMutation,
  useDeleteKeyMutation,
  useProjectKeysQuery,
} from "@/shared/hooks/queries";
import type { CreatedKey } from "@/shared/lib/types";
import { useProjectContext } from "@/shared/store/project";

export const SettingsPage: Component = () => {
  const ctx = useProjectContext();
  const [newKey, setNewKey] = createSignal<CreatedKey | null>(null);
  const [copied, setCopied] = createSignal("");
  const [deleteCandidate, setDeleteCandidate] = createSignal<{
    id: string;
    publicKey: string;
  } | null>(null);

  const keysQuery = useProjectKeysQuery(() => ctx()?.projectId);
  const createKey = useCreateKeyMutation(() => ctx()?.projectId);
  const deleteKey = useDeleteKeyMutation(() => ctx()?.projectId);

  const keys = () => (keysQuery.isSuccess ? keysQuery.data : []);

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
    message.success("Copied to clipboard");
  };

  return (
    <div class="flex h-full flex-col">
      <PageHeaderShell
        title="Settings"
        description={`API keys for project "${ctx()?.projectName ?? ""}".`}
      />

      <div class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-2xl p-24">
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center gap-8 text-lg">
                <KeyRound class="h-16 w-16 text-brand" size={16} />
                API Keys
              </CardTitle>
              <CardDescription>
                Use these with the Peri-Fuse SDK or any Langfuse-compatible client.
              </CardDescription>
            </CardHeader>
            <CardContent class="space-y-16">
              <div class="rounded-md border border-border bg-surface-inset px-12 py-8 text-xs leading-5 text-fg-secondary">
                Keys marked <span class="font-mono">web-ui</span> are created automatically when
                this dashboard activates a project. Up to five recent web-ui keys are kept so open
                browser sessions continue working; older ones are removed automatically.
              </div>
              <div class="flex items-center gap-8">
                <Button
                  variant="primary"
                  onClick={() => {
                    void createKey
                      .mutateAsync()
                      .then((key) => {
                        setNewKey(key);
                        message.success("API key created");
                      })
                      .catch((err) =>
                        message.error(err instanceof Error ? err.message : "Failed to create key"),
                      );
                  }}
                  disabled={createKey.isPending}
                  busy={createKey.isPending}
                  leadingIcon={
                    createKey.isPending ? (
                      <Loader2 class="h-16 w-16 animate-spin" size={16} />
                    ) : (
                      <Plus class="h-16 w-16" size={16} />
                    )
                  }
                >
                  Create new key
                </Button>
              </div>

              <Show
                when={keysQuery.isPending}
                fallback={
                  <Show when={keysQuery.isSuccess}>
                    <Show
                      when={keys().length > 0}
                      fallback={
                        <p class="py-32 text-center text-sm text-fg-tertiary">
                          No API keys yet. Create one to start ingesting data.
                        </p>
                      }
                    >
                      <div class="space-y-8">
                        <For each={keys()}>
                          {(k) => (
                            <div class="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-16 py-12">
                              <div class="min-w-0 flex-1">
                                <div class="truncate font-mono text-sm text-fg-primary">
                                  {k.publicKey}
                                </div>
                                <div class="text-xs text-fg-tertiary">
                                  {k.displaySecretKey} ·{" "}
                                  {new Date(k.createdAt).toLocaleDateString()}
                                  {k.note ? ` · ${k.note}` : ""}
                                </div>
                                <div class="mt-2 text-xs text-fg-tertiary">
                                  {k.expiresAt
                                    ? `Expires ${new Date(k.expiresAt).toLocaleString()}`
                                    : "No expiration"}
                                </div>
                              </div>
                              <div class="flex items-center gap-4">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Copy public key"
                                  onClick={() => void copyToClipboard(k.publicKey, k.id)}
                                >
                                  <Copy class="h-14 w-14" size={14} />
                                  <Show when={copied() === k.id}>
                                    <span class="ml-4 text-xs">Copied</span>
                                  </Show>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Delete key"
                                  onClick={() =>
                                    setDeleteCandidate({ id: k.id, publicKey: k.publicKey })
                                  }
                                >
                                  <Trash2 class="h-14 w-14 text-danger" size={14} />
                                </Button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                }
              >
                <div class="space-y-8 py-16">
                  <Skeleton class="h-64 w-full" />
                  <Skeleton class="h-64 w-full" />
                </div>
              </Show>

              <Show when={keysQuery.isError}>
                <div
                  role="alert"
                  class="flex items-center justify-between rounded-md border border-danger/30 bg-danger-subtle px-12 py-8"
                >
                  <p class="text-sm text-danger">
                    {keysQuery.error instanceof Error
                      ? keysQuery.error.message
                      : "Failed to load API keys"}
                  </p>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void keysQuery.refetch()}
                    disabled={keysQuery.isFetching}
                  >
                    Retry
                  </Button>
                </div>
              </Show>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={!!newKey()} onOpenChange={(open) => !open && setNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>
              Save the secret key now — it cannot be shown again.
            </DialogDescription>
          </DialogHeader>
          <Show when={newKey()}>
            {(key) => (
              <div class="space-y-12">
                <div>
                  <label class="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                    Public Key
                  </label>
                  <div class="mt-4 flex items-center gap-8 rounded-md border border-border bg-surface-inset px-12 py-8">
                    <code class="flex-1 truncate font-mono text-sm">{key().publicKey}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyToClipboard(key().publicKey, "pk")}
                    >
                      <Copy class="h-14 w-14" size={14} />
                    </Button>
                  </div>
                </div>
                <div>
                  <label class="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                    Secret Key
                  </label>
                  <div class="mt-4 flex items-center gap-8 rounded-md border border-border bg-surface-inset px-12 py-8">
                    <code class="flex-1 truncate font-mono text-sm">{key().secretKey}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyToClipboard(key().secretKey, "sk")}
                    >
                      <Copy class="h-14 w-14" size={14} />
                    </Button>
                  </div>
                </div>
                <div class="flex justify-end pt-8">
                  <Button variant="primary" onClick={() => setNewKey(null)}>
                    Done
                  </Button>
                </div>
              </div>
            )}
          </Show>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteCandidate()}
        onOpenChange={(open) => !open && setDeleteCandidate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle class="flex items-center gap-8">
              <AlertTriangle class="h-16 w-16 text-danger" size={16} /> Delete API key?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Requests using this key will stop working immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Show when={deleteCandidate()}>
            {(candidate) => (
              <div class="rounded-md border border-line bg-surface-inset px-12 py-8 font-mono text-xs text-fg-secondary">
                {candidate().publicKey}
              </div>
            )}
          </Show>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              disabled={deleteKey.isPending}
              onClick={() => {
                const candidate = deleteCandidate();
                if (!candidate) return;
                void deleteKey
                  .mutateAsync(candidate.id)
                  .then(() => {
                    setDeleteCandidate(null);
                    message.success("API key deleted");
                  })
                  .catch((err) =>
                    message.error(err instanceof Error ? err.message : "Failed to delete key"),
                  );
              }}
            >
              <Show when={deleteKey.isPending}>
                <Loader2 class="h-16 w-16 animate-spin" size={16} />
              </Show>
              Delete key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
