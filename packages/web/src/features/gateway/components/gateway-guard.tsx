/**
 * Gateway admin key guard — wraps gateway pages and shows a setup prompt
 * when no admin key is configured.
 */
import { KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { getGatewayAdminKey, setGatewayAdminKey } from "@/shared/lib/gateway-api";

export function GatewayGuard({ children }: { children: ReactNode }) {
  const [adminKey, setAdminKey] = useState(getGatewayAdminKey());
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  if (adminKey) {
    return <>{children}</>;
  }

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSaving(true);
    setGatewayAdminKey(trimmed);
    setAdminKey(trimmed);
    setSaving(false);
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="h-4 w-4 text-brand" />
            Gateway Admin Key
          </CardTitle>
          <CardDescription>
            Enter the admin key configured via <code className="font-mono text-xs">GATEWAY_ADMIN_KEY</code> in
            the gateway&apos;s .env file. It is stored locally in your browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="Admin key…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
            <Button onClick={save} disabled={!draft.trim() || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
