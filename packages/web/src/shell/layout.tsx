import { MessageHost } from "@peri/ui";
import { Menu, X } from "lucide-solid";
import { createSignal, onCleanup, type ParentComponent, Show } from "solid-js";
import { cn } from "@/shared/lib/utils";
import { useSidebarCollapsed } from "@/shared/store/sidebar";
import { AppChrome } from "./app-chrome";
import { BrandMark, SidebarNav } from "./sidebar-nav";

export const Layout: ParentComponent = (props) => {
  const collapsed = useSidebarCollapsed();
  const [mobileOpen, setMobileOpen] = createSignal(false);

  const lockScroll = (open: boolean) => {
    document.body.style.overflow = open ? "hidden" : "";
  };

  const openMobile = () => {
    setMobileOpen(true);
    lockScroll(true);
  };

  const closeMobile = () => {
    setMobileOpen(false);
    lockScroll(false);
  };

  onCleanup(() => lockScroll(false));

  return (
    <div class="flex h-screen overflow-hidden bg-background text-foreground">
      <aside
        class={cn(
          "hidden shrink-0 transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] md:block",
          collapsed() ? "w-16" : "w-60",
        )}
      >
        <SidebarNav />
      </aside>

      <Show when={mobileOpen()}>
        <div class="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            class="absolute inset-0 bg-black/50"
            onClick={closeMobile}
            aria-label="Close navigation"
          />
          <aside class="absolute inset-y-0 left-0 w-60 border-r border-border bg-surface-raised shadow-lg">
            <button
              type="button"
              onClick={closeMobile}
              class="absolute right-2 top-3 rounded-md p-1.5 text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-primary"
              aria-label="Close menu"
            >
              <X class="h-4 w-4" size={16} />
            </button>
            <SidebarNav onNavigate={closeMobile} />
          </aside>
        </div>
      </Show>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-surface-raised px-3 md:hidden">
          <button
            type="button"
            onClick={openMobile}
            class="rounded-md p-1.5 text-fg-secondary hover:bg-surface-overlay/70 hover:text-fg-primary"
            aria-label="Open menu"
          >
            <Menu class="h-4 w-4" size={16} />
          </button>
          <BrandMark size={24} />
          <span class="text-[13px] font-semibold text-fg-primary">Peri-Fuse Lite</span>
        </div>

        <main class="min-w-0 flex-1 overflow-y-auto">{props.children}</main>
      </div>

      <MessageHost />
      <AppChrome />
    </div>
  );
};
