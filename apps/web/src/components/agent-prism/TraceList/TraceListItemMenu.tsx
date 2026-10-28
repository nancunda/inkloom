import type { TraceRecord } from "@evilmartians/agent-prism-types";
import type { ReactElement } from "react";

import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ReadonlyProps } from "../ReadonlyProps";

import { IconButton } from "../IconButton";

type TraceListItemMenuProps = {
  /** Render the dropdown above the trigger (use for the last row of a scroll container) */
  above?: boolean | undefined;
  onDelete?: ((trace: TraceRecord) => void) | undefined;
  onRename?: ((trace: TraceRecord) => void) | undefined;
  trace: TraceRecord;
};

/**
 * Per-row "..." actions. Deliberately dependency-free: a plain trigger button
 * plus an absolutely positioned panel, closed on outside mousedown, on Escape,
 * or on picking an action.
 *
 * Not a `role="menu"`: that role promises arrow-key navigation we do not
 * implement, so the actions stay plain buttons inside a disclosure.
 */
export const TraceListItemMenu = ({
  above = false,
  onDelete,
  onRename,
  trace,
}: ReadonlyProps<TraceListItemMenuProps>): ReactElement | null => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (
        containerRef.current !== null &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (onRename === undefined && onDelete === undefined) return null;

  const run = (action: ((target: TraceRecord) => void) | undefined) => (): void => {
    setOpen(false);
    action?.(trace);
  };

  const itemClassName =
    "text-agentprism-foreground hover:bg-agentprism-secondary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs";

  return (
    <div
      className="relative"
      onClick={(event) => {
        // 否则点菜单会顺带选中这一行
        event.stopPropagation();
      }}
      ref={containerRef}
    >
      <IconButton
        aria-expanded={open}
        aria-label={`更多操作：${trace.name}`}
        onClick={() => {
          setOpen((value) => !value);
        }}
        ref={triggerRef}
        size="6"
        variant="ghost"
      >
        <MoreHorizontal className="size-3.5" />
      </IconButton>

      {open ? (
        <div
          className={`border-agentprism-border bg-agentprism-background absolute right-0 z-10 w-28 overflow-hidden rounded-md border shadow-md ${
            above ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {onRename === undefined ? null : (
            <button className={itemClassName} onClick={run(onRename)} type="button">
              <Pencil className="size-3" />
              改名
            </button>
          )}
          {onDelete === undefined ? null : (
            <button className={itemClassName} onClick={run(onDelete)} type="button">
              <Trash2 className="size-3" />
              删除
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
};
