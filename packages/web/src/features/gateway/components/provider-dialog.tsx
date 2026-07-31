/**
 * Create/Edit Provider dialog form.
 */
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import type { GatewayProvider } from "@/shared/lib/gateway-api";

interface ProviderFormState {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  budgetLimit: string;
  budgetPeriod: string;
}

const emptyForm: ProviderFormState = {
  name: "",
  type: "openai",
  baseUrl: "",
  apiKey: "",
  budgetLimit: "",
  budgetPeriod: "",
};

export function ProviderDialog({
  open,
  onOpenChange,
  provider,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider?: GatewayProvider | null;
  onSubmit: (body: {
    name: string;
    type: string;
    baseUrl: string;
    apiKey?: string;
    budgetLimit?: number | null;
    budgetPeriod?: string | null;
  }) => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState<ProviderFormState>(emptyForm);
  const isEdit = !!provider;

  useEffect(() => {
    if (open) {
      setForm(
        provider
          ? {
              name: provider.name,
              type: provider.type,
              baseUrl: provider.baseUrl,
              apiKey: "",
              budgetLimit: provider.budgetLimit != null ? String(provider.budgetLimit) : "",
              budgetPeriod: provider.budgetPeriod ?? "",
            }
          : emptyForm,
      );
    }
  }, [open, provider]);

  const set = (field: keyof ProviderFormState) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleSubmit = () => {
    onSubmit({
      name: form.name.trim(),
      type: form.type,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim() || undefined,
      budgetLimit: form.budgetLimit ? Number(form.budgetLimit) : null,
      budgetPeriod: form.budgetPeriod || null,
    });
  };

  const valid = form.name.trim() && form.baseUrl.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Provider" : "Add Provider"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update provider configuration."
              : "Connect an LLM provider to the gateway."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              placeholder="e.g. openai-prod"
              value={form.name}
              onChange={(e) => set("name")(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={form.type} onValueChange={set("type")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI-compatible</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Base URL</Label>
            <Input
              placeholder="https://api.openai.com/v1"
              value={form.baseUrl}
              onChange={(e) => set("baseUrl")(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>
              API Key {isEdit && <span className="font-normal text-fg-tertiary">(leave blank to keep current)</span>}
            </Label>
            <Input
              type="password"
              placeholder={isEdit ? "••••••••" : "sk-..."}
              value={form.apiKey}
              onChange={(e) => set("apiKey")(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Budget Limit ($)</Label>
              <Input
                type="number"
                placeholder="Optional"
                value={form.budgetLimit}
                onChange={(e) => set("budgetLimit")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Budget Period</Label>
              <Input
                placeholder="e.g. 30d, 24h"
                value={form.budgetPeriod}
                onChange={(e) => set("budgetPeriod")(e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!valid || isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
