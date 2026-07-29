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

import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", label: "Dashboard", icon: Gauge, end: true },
  { to: "/traces", label: "Traces", icon: ListTree, end: false },
  { to: "/sessions", label: "Sessions", icon: Users, end: false },
  { to: "/observations", label: "Observations", icon: Activity, end: false },
  { to: "/scores", label: "Scores", icon: Star, end: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, end: false },
];

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Database className="h-5 w-5 text-primary" />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Langfuse</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Lite</span>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
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
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
