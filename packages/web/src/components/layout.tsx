import {
  Activity,
  Database,
  Gauge,
  ListTree,
  Settings as SettingsIcon,
  Star,
  Users,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { ProjectSwitcher } from "@/components/project-switcher";
import { cn } from "@/lib/utils";
import { useProjectContext } from "@/store/project";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: Gauge },
  { to: "/traces", label: "Traces", icon: ListTree },
  { to: "/sessions", label: "Sessions", icon: Users },
  { to: "/observations", label: "Observations", icon: Activity },
  { to: "/scores", label: "Scores", icon: Star },
];

export function Layout() {
  const ctx = useProjectContext();
  const active = ctx !== null;

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border">
        {/* Brand */}
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Database className="h-5 w-5 text-primary" />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Peri-Fuse</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Lite</span>
          </div>
        </div>

        {/* Project Switcher */}
        <div className="border-b border-border py-2">
          <ProjectSwitcher />
        </div>

        {/* Navigation */}
        {active && (
          <nav className="flex-1 space-y-1 overflow-y-auto p-2">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        )}

        {/* Bottom: Settings */}
        {active && (
          <div className="border-t border-border p-2">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )
              }
            >
              <SettingsIcon className="h-4 w-4" />
              Settings
            </NavLink>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
