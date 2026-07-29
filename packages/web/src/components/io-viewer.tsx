/**
 * IoViewer — smart viewer for trace/observation input & output.
 *
 * Automatically detects chat-style payloads ({messages: [...]} or a bare
 * message array) and offers a Chat ⇄ JSON toggle. Non-chat data renders
 * directly as JSON.
 */
import { Braces, MessageSquareText } from "lucide-react";
import { useMemo, useState } from "react";
import { extractMessages, isChatPayload } from "@/components/chat-utils";
import { ChatViewer } from "@/components/chat-viewer";
import { JsonViewer } from "@/components/json-viewer";
import { cn } from "@/lib/utils";

type ViewMode = "chat" | "json";

function ModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="inline-flex h-7 items-center rounded-md border border-border bg-muted/50 p-0.5">
      <button
        type="button"
        onClick={() => onChange("chat")}
        className={cn(
          "inline-flex h-full items-center gap-1 rounded-[5px] px-2.5 text-[11px] font-medium transition-all",
          mode === "chat"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <MessageSquareText className="h-3 w-3" />
        Chat
      </button>
      <button
        type="button"
        onClick={() => onChange("json")}
        className={cn(
          "inline-flex h-full items-center gap-1 rounded-[5px] px-2.5 text-[11px] font-medium transition-all",
          mode === "json"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Braces className="h-3 w-3" />
        JSON
      </button>
    </div>
  );
}

export function IoViewer({ data }: { data: unknown }) {
  const isChat = useMemo(() => isChatPayload(data), [data]);
  const messages = useMemo(() => (isChat ? extractMessages(data) : null), [data, isChat]);
  const [mode, setMode] = useState<ViewMode>("chat");

  if (!isChat || !messages) {
    return <JsonViewer data={data} />;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      {mode === "chat" ? <ChatViewer messages={messages} /> : <JsonViewer data={data} />}
    </div>
  );
}
