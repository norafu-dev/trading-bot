"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface GroupComboboxProps {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}

export function GroupCombobox({
  value,
  onChange,
  options,
  placeholder = "选择或输入分组名",
  className,
}: GroupComboboxProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("flex", className)}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-r-none border-r-0 focus-visible:z-10"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-r-lg border border-input bg-transparent text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground",
            open && "bg-muted text-foreground",
          )}
          aria-label="选择分组"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-48 p-1">
          {options.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">暂无已有分组</p>
          ) : (
            <div className="space-y-0.5">
              {options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => { onChange(opt); setOpen(false); }}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    value === opt && "bg-primary/10 text-primary font-medium",
                  )}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          {value.trim() && !options.includes(value.trim()) && (
            <>
              {options.length > 0 && <div className="my-1 border-t border-border" />}
              <p className="px-2 py-1 text-xs text-muted-foreground">
                按回车创建「{value.trim()}」
              </p>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
