/**
 * Create/Edit Model Deployment dialog form.
 *
 * Form behavior & validation via React Hook Form + Zod (shadcn/ui Form).
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/shared/components/ui/form";
import { Input } from "@/shared/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { useGwProvidersQuery } from "@/shared/hooks/gateway-queries";
import type { ModelDeployment } from "@/shared/lib/gateway-api";

const modelFormSchema = z.object({
  modelName: z.string().trim().min(1, "Model alias is required"),
  providerId: z.string().min(1, "Please select a provider"),
  providerModel: z.string().trim().min(1, "Provider model is required"),
  inputPrice: z.string().refine((v) => v === "" || !Number.isNaN(Number(v)), {
    message: "Must be a valid number",
  }),
  outputPrice: z.string().refine((v) => v === "" || !Number.isNaN(Number(v)), {
    message: "Must be a valid number",
  }),
});

type ModelFormValues = z.infer<typeof modelFormSchema>;

export function ModelDialog({
  open,
  onOpenChange,
  deployment,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deployment?: ModelDeployment | null;
  onSubmit: (body: {
    modelName: string;
    providerId: string;
    providerModel: string;
    modelInfo?: { inputPrice?: number; outputPrice?: number } | null;
  }) => void;
  isPending: boolean;
}) {
  const providersQuery = useGwProvidersQuery();
  const isEdit = !!deployment;

  const form = useForm<ModelFormValues>({
    resolver: zodResolver(modelFormSchema),
    defaultValues: {
      modelName: "",
      providerId: "",
      providerModel: "",
      inputPrice: "",
      outputPrice: "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset(
        deployment
          ? {
              modelName: deployment.modelName,
              providerId: deployment.providerId,
              providerModel: deployment.providerModel,
              inputPrice:
                deployment.modelInfo?.inputPrice != null
                  ? String(deployment.modelInfo.inputPrice)
                  : "",
              outputPrice:
                deployment.modelInfo?.outputPrice != null
                  ? String(deployment.modelInfo.outputPrice)
                  : "",
            }
          : {
              modelName: "",
              providerId: "",
              providerModel: "",
              inputPrice: "",
              outputPrice: "",
            },
      );
    }
  }, [open, deployment, form]);

  const providers = (providersQuery.data ?? []).filter((p) => p.isEnabled);

  const handleSubmit = (values: ModelFormValues) => {
    const hasPricing = values.inputPrice !== "" || values.outputPrice !== "";
    onSubmit({
      modelName: values.modelName,
      providerId: values.providerId,
      providerModel: values.providerModel,
      modelInfo: hasPricing
        ? {
            inputPrice: values.inputPrice ? Number(values.inputPrice) : undefined,
            outputPrice: values.outputPrice ? Number(values.outputPrice) : undefined,
          }
        : null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Deployment" : "Add Deployment"}</DialogTitle>
          <DialogDescription>
            Map a public model alias to a provider&apos;s model.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="modelName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Model Alias</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. gpt-4o" {...field} />
                  </FormControl>
                  <FormDescription>The name clients use in their requests.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="providerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select provider…" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {providers.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} ({p.type})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="providerModel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider Model</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. gpt-4o-2024-08-06" {...field} />
                  </FormControl>
                  <FormDescription>The actual model ID sent to the provider.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="inputPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Input Price ($/1M)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="Optional" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="outputPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Output Price ($/1M)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="Optional" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {isEdit ? "Save" : "Create"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
