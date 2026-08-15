/**
 * Create/Edit Provider dialog form.
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
import type { GatewayProvider } from "@/shared/lib/gateway-api";

const providerFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  type: z.string().min(1, "Type is required"),
  baseUrl: z.string().trim().min(1, "Base URL is required").url("Must be a valid URL"),
  apiKey: z.string().trim(),
  budgetLimit: z.string().refine((v) => v === "" || !Number.isNaN(Number(v)), {
    message: "Must be a valid number",
  }),
  budgetPeriod: z.string().trim(),
});

type ProviderFormValues = z.infer<typeof providerFormSchema>;

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
  const isEdit = !!provider;

  const form = useForm<ProviderFormValues>({
    resolver: zodResolver(providerFormSchema),
    defaultValues: {
      name: "",
      type: "openai",
      baseUrl: "",
      apiKey: "",
      budgetLimit: "",
      budgetPeriod: "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset(
        provider
          ? {
              name: provider.name,
              type: provider.type,
              baseUrl: provider.baseUrl,
              apiKey: "",
              budgetLimit: provider.budgetLimit != null ? String(provider.budgetLimit) : "",
              budgetPeriod: provider.budgetPeriod ?? "",
            }
          : {
              name: "",
              type: "openai",
              baseUrl: "",
              apiKey: "",
              budgetLimit: "",
              budgetPeriod: "",
            },
      );
    }
  }, [open, provider, form]);

  const handleSubmit = (values: ProviderFormValues) => {
    onSubmit({
      name: values.name,
      type: values.type,
      baseUrl: values.baseUrl,
      apiKey: values.apiKey || undefined,
      budgetLimit: values.budgetLimit ? Number(values.budgetLimit) : null,
      budgetPeriod: values.budgetPeriod || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Provider" : "Add Provider"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update provider configuration." : "Connect an LLM provider to the gateway."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. openai-prod" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI-compatible</SelectItem>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="baseUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Base URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://api.openai.com/v1" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="apiKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    API Key{" "}
                    {isEdit && (
                      <span className="font-normal text-fg-tertiary">
                        (leave blank to keep current)
                      </span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={isEdit ? "••••••••" : "sk-..."}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="budgetLimit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Budget Limit ($)</FormLabel>
                    <FormControl>
                      <Input type="number" placeholder="Optional" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="budgetPeriod"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Budget Period</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. 30d, 24h" {...field} />
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
