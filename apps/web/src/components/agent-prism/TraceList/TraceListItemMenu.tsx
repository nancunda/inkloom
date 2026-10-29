import type { TraceRecord } from "@evilmartians/agent-prism-types";
import type { ReactElement } from "react";

import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ReadonlyProps } from "../ReadonlyProps";

import { IconButton } from "../IconButton";

type TraceListItemMenuProps = {
  /** Hint to render the dropdown above the trigger regardless of space */
  above?: boolean | undefined;
  onDelete?: ((trace: TraceRecord) => void) | undefined;
  onRename?: ((trace: TraceRecord) => void) | undefined;
  trace: TraceRecord;
};

/** 菜单面板高度（两项 + 内边距）＋一点余量，用于判断要不要往上弹 */
const MENU_HEIGHT = 92;

/** 触发按钮所在的滚动容器在视口里的底边（没有滚动容器就用视口底边） */
function visibleBottom(trigger: HTMLElement): number {
  let bottom = window.innerHeight;
  let node: HTMLElement | null = trigger.parentElement;
  while (node !== null) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      return Math.min(bottom, node.getBoundingClientRect().bottom);
    }
    node = node.parentElement;
  }
  return bottom;
}

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
  // ★ 不能按「数据最后一行」预判方向：列表会滚，可视区底部那一行往往不是最后一行，
  //   菜单会被 overflow 容器裁掉。打开时量一下真实位置再决定往上还是往下；
  //   `above` 只在量不到（没有 trigger）时做兜底。
  const [openUp, setOpenUp] = useState<boolean | null>(null);
  /** 面板方向：量到的优先，没量到才退回调用方的提示 */
  const panelAbove = openUp ?? above;
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
          if (!open) {
            const trigger = triggerRef.current;
            setOpenUp(
              trigger === null
                ? above
                : trigger.getBoundingClientRect().bottom + MENU_HEIGHT > visibleBottom(trigger),
            );
          }
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
            panelAbove ? "bottom-full mb-1" : "top-full mt-1"
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
