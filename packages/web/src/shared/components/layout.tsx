/**
 * App shell — Spectra §6.4 / §8.
 *
 * Desktop: collapsible sidebar (240px ↔ 64px, persisted) + fluid main area.
 * Mobile (<md): fixed top bar with a slide-in drawer.
 * Brand mark is a solid brand-color square (no gradients — design rule).
 */
import {
  Activity,
  BarChart3,
  Boxes,
  Database,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListTree,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Search,
  Server,
  Settings as SettingsIcon,
  Star,
  Sun,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { CommandPalette, openCommandPalette } from "@/shared/components/command-palette";
import { ProjectSwitcher } from "@/shared/components/project-switcher";
import { ShortcutsDialog } from "@/shared/components/shortcuts-dialog";
import { cn } from "@/shared/lib/utils";
import { useProjectContext } from "@/shared/store/project";
import { toggleTheme, useTheme } from "@/shared/store/theme";

const SIDEBAR_KEY = "peri-fuse-sidebar-collapsed";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: Gauge },
  { to: "/traces", label: "Traces", icon: ListTree },
  { to: "/sessions", label: "Sessions", icon: Users },
  { to: "/users", label: "Users", icon: UserRound },
  { to: "/observations", label: "Observations", icon: Activity },
  { to: "/scores", label: "Scores", icon: Star },
];

const gatewayNavItems = [
  { to: "/gateway", label: "Overview", icon: LayoutDashboard },
  { to: "/gateway/providers", label: "Providers", icon: Server },
  { to: "/gateway/models", label: "Models", icon: Boxes },
  { to: "/gateway/keys", label: "Keys", icon: KeyRound },
  { to: "/gateway/usage", label: "Usage", icon: BarChart3 },
  { to: "/gateway/logs", label: "Logs", icon: ScrollText },
];

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  return [collapsed, toggle] as const;
}

/** Solid brand mark — flat brand background, never a gradient. */
function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-md bg-brand"
      style={{ width: size, height: size }}
    >
      <Database className="text-brand-fg" style={{ width: size * 0.57, height: size * 0.57 }} />
    </div>
  );
}

/** Compact search trigger that opens the command palette. */
function CommandTrigger() {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-surface-inset px-2.5 text-[13px] text-fg-tertiary transition-colors duration-150 hover:border-line-strong hover:text-fg-secondary"
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate text-left">Search…</span>
      <kbd className="shrink-0 rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px]">
        ⌘K
      </kbd>
    </button>
  );
}

function NavItem({
  to,
  label,
  icon: Icon,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof Gauge;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          "relative flex h-8 items-center gap-2.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-150",
          collapsed && "justify-center px-0",
          isActive
            ? "bg-brand-subtle text-brand"
            : "text-fg-secondary hover:bg-surface-overlay/70 hover:text-fg-primary",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-brand" />
          )}
          <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  );
}

function SidebarContent({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const ctx = useProjectContext();
  const active = ctx !== null;
  const theme = useTheme();

  return (
    <div className="flex h-full flex-col">
      {/* Brand — 52px */}
      <div
        className={cn(
          "flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border px-3",
          collapsed && "justify-center px-0",
        )}
      >
        <BrandMark />
        {!collapsed && (
          <span className="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg-primary">
            Peri-Fuse
            <span className="ml-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-fg-tertiary">
              Lite
            </span>
          </span>
        )}
      </div>

      {/* Project switcher — single-line 34px */}
      <div className="shrink-0 border-b border-border p-2">
        <ProjectSwitcher collapsed={collapsed} onNavigate={onNavigate} />
      </div>

      {/* Command palette trigger */}
      {!collapsed && (
        <div className="shrink-0 px-2 pb-2">
          <CommandTrigger />
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {active && (
          <>
            {!collapsed && (
              <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
                Observability
              </p>
            )}
            {navItems.map((item) => (
              <NavItem key={item.to} {...item} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </>
        )}
        {!collapsed && (
          <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary">
            Gateway
          </p>
        )}
        {collapsed && <div className="my-2 border-t border-border" />}
        {gatewayNavItems.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </nav>

      {/* Bottom: settings / theme / collapse */}
      <div className="shrink-0 space-y-0.5 border-t border-border p-2">
        {active && (
          <NavItem
            to="/settings"
            label="Settings"
            icon={SettingsIcon}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        )}
        <button
          type="button"
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className={cn(
            "flex h-8 w-full items-center gap-2.5 rounded-md px-3 text-[13px] font-medium text-fg-secondary transition-colors duration-150 hover:bg-surface-overlay/70 hover:text-fg-primary",
            collapsed && "justify-center px-0",
          )}
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          ) : (
            <Moon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          )}
          {!collapsed && <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>}
        </button>
      </div>
    </div>
  );
}

export function Layout() {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 border-r border-border bg-surface-raised transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] md:block",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <SidebarContent collapsed={collapsed} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
            onKeyDown={(e) => e.key === "Escape" && setMobileOpen(false)}
            role="button"
            tabIndex={-1}
            aria-label="Close navigation"
          />
          <aside className="absolute inset-y-0 left-0 w-60 border-r border-border bg-surface-raised shadow-lg animate-[spectra-drawer-in_200ms_ease-out]">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-2 top-3 rounded-md p-1.5 text-fg-tertiary hover:bg-surface-overlay/70 hover:text-fg-primary"
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarContent collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-surface-raised px-3 md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-1.5 text-fg-secondary hover:bg-surface-overlay/70 hover:text-fg-primary"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <BrandMark size={24} />
          <span className="text-[13px] font-semibold text-fg-primary">Peri-Fuse Lite</span>
        </div>

        {/* Desktop collapse handle — floats on the sidebar border */}
        <div className="relative flex min-h-0 flex-1">
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="absolute -left-3 top-[70px] z-20 hidden h-6 w-6 items-center justify-center rounded-full border border-border bg-surface-raised text-fg-tertiary shadow-sm transition-colors hover:text-fg-primary md:flex"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" />
            )}
          </button>

          <main className="min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Global command palette (Cmd+K) */}
      <CommandPalette />

      {/* Keyboard shortcuts help (?) */}
      <ShortcutsDialog />
    </div>
  );
}
