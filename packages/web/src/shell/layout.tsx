import { MessageHost } from "@peri/ui";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-solid";
import { createSignal, onCleanup, type ParentComponent, Show } from "solid-js";
import { cn } from "@/shared/lib/utils";
import { toggleSidebarCollapsed, useSidebarCollapsed } from "@/shared/store/sidebar";
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
          collapsed() ? "w-64" : "w-240",
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
          <aside class="absolute inset-y-0 left-0 w-240 border-r border-border bg-surface-raised shadow-lg">
            <button
              type="button"
              onClick={closeMobile}
              class="absolute right-8 top-12 rounded-md p-6 text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-primary"
              aria-label="Close menu"
            >
              <X class="h-16 w-16" size={16} />
            </button>
            <SidebarNav onNavigate={closeMobile} />
          </aside>
        </div>
      </Show>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex h-48 shrink-0 items-center gap-10 border-b border-border bg-surface-raised px-12 md:hidden">
          <button
            type="button"
            onClick={openMobile}
            class="rounded-md p-6 text-fg-secondary hover:bg-surface-overlay/70 hover:text-fg-primary"
            aria-label="Open menu"
          >
            <Menu class="h-16 w-16" size={16} />
          </button>
          <BrandMark size={24} />
          <span class="text-[13px] font-semibold text-fg-primary">Peri-Fuse Lite</span>
        </div>

        <div class="relative flex min-h-0 flex-1">
          <button
            type="button"
            onClick={toggleSidebarCollapsed}
            title={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
            class="absolute -left-12 top-[70px] z-20 hidden h-24 w-24 items-center justify-center rounded-full border border-border bg-surface-raised text-fg-tertiary shadow-sm transition-colors hover:text-fg-primary md:flex"
          >
            <Show
              when={collapsed()}
              fallback={<PanelLeftClose class="h-14 w-14" size={14} strokeWidth={1.75} />}
            >
              <PanelLeftOpen class="h-14 w-14" size={14} strokeWidth={1.75} />
            </Show>
          </button>

          <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{props.children}</main>
        </div>
      </div>

      <MessageHost />
      <AppChrome />
    </div>
  );
};
