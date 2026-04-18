"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const DEFAULT_NAV: NavItem[] = [
  {
    href: "/",
    label: "概览",
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
      </svg>
    ),
  },
  {
    href: "/messages",
    label: "信号消息",
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
      </svg>
    ),
  },
  {
    href: "/kols",
    label: "KOL 管理",
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
  },
  {
    href: "/channels",
    label: "频道管理",
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 8.25h15m-16.5 7.5h15m-1.8-13.5l-3.6 19.5m-2.4-19.5l-3.6 19.5" />
      </svg>
    ),
  },
  {
    href: "/export",
    label: "数据导出",
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    ),
  },
];

const STORAGE_KEY = "sidebar-nav-order";

function loadOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch { return null; }
}

function saveOrder(order: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
}

function applyOrder(items: NavItem[], order: string[] | null): NavItem[] {
  if (!order) return items;
  const map = new Map(items.map((it) => [it.href, it]));
  const sorted: NavItem[] = [];
  for (const href of order) {
    const item = map.get(href);
    if (item) { sorted.push(item); map.delete(href); }
  }
  for (const item of map.values()) sorted.push(item);
  return sorted;
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-8 w-24" />;

  const options = [
    { value: "light", icon: <Sun className="h-3.5 w-3.5" />, label: "亮" },
    { value: "dark", icon: <Moon className="h-3.5 w-3.5" />, label: "暗" },
    { value: "system", icon: <Monitor className="h-3.5 w-3.5" />, label: "系统" },
  ] as const;

  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => setTheme(o.value)}
          title={o.label}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
            theme === o.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [items, setItems] = useState(DEFAULT_NAV);
  const dragIdx = useRef<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  useEffect(() => {
    setItems(applyOrder(DEFAULT_NAV, loadOrder()));
  }, []);

  const handleDragStart = useCallback((idx: number) => { dragIdx.current = idx; }, []);
  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx.current !== null && dragIdx.current !== idx) setDropIdx(idx);
  }, []);
  const handleDrop = useCallback((idx: number) => {
    const from = dragIdx.current;
    if (from === null || from === idx) return;
    setItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(idx, 0, moved);
      saveOrder(next.map((it) => it.href));
      return next;
    });
    dragIdx.current = null;
    setDropIdx(null);
  }, []);
  const handleDragEnd = useCallback(() => { dragIdx.current = null; setDropIdx(null); }, []);

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
          T
        </div>
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
          Trading Bot
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-4">
        {items.map((item, i) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              draggable
              onDragStart={() => handleDragStart(i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={() => handleDrop(i)}
              onDragEnd={handleDragEnd}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              } ${dropIdx === i ? "ring-1 ring-primary/40" : ""}`}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3 border-t border-border px-4 py-4">
        <ThemeToggle />
        <p className="text-xs text-muted-foreground">Signal :3001</p>
      </div>
    </aside>
  );
}
