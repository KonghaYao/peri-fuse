/**
 * Create Key Config dialog — attach gateway limits to a publicKey.
 */
import { Loader2 } from "lucide-react";
import { useState } from "react";
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

interface KeyFormState {
  publicKey: string;
  keyName: string;
  rpmLimit: string;
  tpmLimit: string;
  maxParallel: string;
  maxBudget: string;
}

const emptyForm: KeyFormState = {
  publicKey: "",
  keyName: "",
  rpmLimit: "",
  tpmLimit: "",
  maxParallel: "",
  maxBudget: "",
};

export function KeyDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: {
    publicKey: string;
    keyName?: string;
    rpmLimit?: number | null;
    tpmLimit?: number | null;
    maxParallel?: number | null;
    maxBudget?: number | null;
  }) => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState<KeyFormState>(emptyForm);

  const set = (field: keyof KeyFormState) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleClose = (v: boolean) => {
    if (!v) setForm(emptyForm);
    onOpenChange(v);
  };

  const handleSubmit = () => {
    onSubmit({
      publicKey: form.publicKey.trim(),
      keyName: form.keyName.trim() || undefined,
      rpmLimit: form.rpmLimit ? Number(form.rpmLimit) : null,
      tpmLimit: form.tpmLimit ? Number(form.tpmLimit) : null,
      maxParallel: form.maxParallel ? Number(form.maxParallel) : null,
      maxBudget: form.maxBudget ? Number(form.maxBudget) : null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Key Config</DialogTitle>
          <DialogDescription>
            Attach rate limits and budget to an existing public key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Public Key</Label>
            <Input
              placeholder="pk-lf-..."
              value={form.publicKey}
              onChange={(e) => set("publicKey")(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Key Name</Label>
            <Input
              placeholder="e.g. production-app"
              value={form.keyName}
              onChange={(e) => set("keyName")(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>RPM Limit</Label>
              <Input
                type="number"
                placeholder="Unlimited"
                value={form.rpmLimit}
                onChange={(e) => set("rpmLimit")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>TPM Limit</Label>
              <Input
                type="number"
                placeholder="Unlimited"
                value={form.tpmLimit}
                onChange={(e) => set("tpmLimit")(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Max Parallel</Label>
              <Input
                type="number"
                placeholder="Unlimited"
                value={form.maxParallel}
                onChange={(e) => set("maxParallel")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Max Budget ($)</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="Unlimited"
                value={form.maxBudget}
                onChange={(e) => set("maxBudget")(e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => handleClose(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isPending || !form.publicKey.trim()}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Add Config
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

