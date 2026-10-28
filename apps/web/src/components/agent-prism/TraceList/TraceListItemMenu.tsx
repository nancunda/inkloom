import type { TraceRecord } from "@evilmartians/agent-prism-types";
import type { ReactElement } from "react";

import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ReadonlyProps } from "../ReadonlyProps";

import { IconButton } from "../IconButton";

type TraceListItemMenuProps = {
  onDelete: (trace: TraceRecord) => void;
  onRename: (trace: TraceRecord) => void;
  trace: TraceRecord;
};

/**
 * Per-row "..." menu. Deliberately dependency-free: a plain button plus an
 * absolutely positioned list, closed on outside mousedown or on picking an
 * action.
 */
export const TraceListItemMenu = ({
  onDelete,
  onRename,
  trace,
}: ReadonlyProps<TraceListItemMenuProps>): ReactElement => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  const run = (action: (target: TraceRecord) => void) => (): void => {
    setOpen(false);
    action(trace);
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
        aria-haspopup="menu"
        aria-label={`更多操作：${trace.name}`}
        className="group-hover:opacity-100 focus-visible:opacity-100 opacity-0 transition-opacity"
        onClick={() => {
          setOpen((value) => !value);
        }}
        size="6"
        variant="ghost"
      >
        <MoreHorizontal className="size-3.5" />
      </IconButton>

      {open ? (
        <div
          className="border-agentprism-border bg-agentprism-background absolute top-full right-0 z-10 mt-1 w-28 overflow-hidden rounded-md border shadow-md"
          role="menu"
        >
          <button
            className={itemClassName}
            onClick={run(onRename)}
            role="menuitem"
            type="button"
          >
            <Pencil className="size-3" />
            改名
          </button>
          <button
            className={itemClassName}
            onClick={run(onDelete)}
            role="menuitem"
            type="button"
          >
            <Trash2 className="size-3" />
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
};
