import { KeyRound, Loader2, PlugZap } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { healthCheck } from "@/lib/api";
import { isAuthConfigured, setAuthConfig, useAuthConfig } from "@/store/auth";

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

export function SettingsPage() {
  const config = useAuthConfig();
  const navigate = useNavigate();

  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [publicKey, setPublicKey] = useState(config.publicKey);
  const [secretKey, setSecretKey] = useState(config.secretKey);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const save = () => {
    setAuthConfig({ baseUrl, publicKey, secretKey });
    setTest({ status: "ok", message: "Credentials saved." });
  };

  const saveAndGoHome = () => {
    save();
    navigate("/");
  };

  const runTest = async () => {
    // Persist first so the client under test uses the latest values.
    setAuthConfig({ baseUrl, publicKey, secretKey });
    setTest({ status: "testing" });
    try {
      const res = await healthCheck();
      setTest({
        status: "ok",
        message: `Connected. Server status: ${res.status}.`,
      });
    } catch (err) {
      setTest({
        status: "error",
        message: err instanceof Error ? err.message : "Connection failed (network).",
      });
    }
  };

  const canSave = publicKey.trim().length > 0 && secretKey.trim().length > 0;

  return (
    <div className="mx-auto max-w-xl p-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            Connect to lite-server
          </CardTitle>
          <CardDescription>
            Enter the API keys of your Langfuse lite project. These are the same public/secret keys
            used by the SDK (Basic auth). Leave the base URL empty when the UI is served by the
            lite-server itself.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="baseUrl">Base URL (optional)</Label>
            <Input
              id="baseUrl"
              placeholder="e.g. http://localhost:23332 (empty = same origin)"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="publicKey">Public key</Label>
            <Input
              id="publicKey"
              placeholder="pk-lf-..."
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="secretKey">Secret key</Label>
            <Input
              id="secretKey"
              type="password"
              placeholder="sk-lf-..."
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              autoComplete="off"
            />
          </div>

          {test.status === "ok" && <p className="text-sm text-emerald-500">{test.message}</p>}
          {test.status === "error" && <p className="text-sm text-red-500">{test.message}</p>}

          <div className="flex items-center gap-2 pt-2">
            <Button onClick={runTest} variant="outline" disabled={!canSave}>
              {test.status === "testing" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PlugZap className="h-4 w-4" />
              )}
              Test connection
            </Button>
            {isAuthConfigured() ? (
              <Button onClick={save}>Save</Button>
            ) : (
              <Button onClick={saveAndGoHome} disabled={!canSave}>
                Save &amp; continue
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
