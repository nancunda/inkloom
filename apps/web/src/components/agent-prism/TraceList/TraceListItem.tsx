import type { TraceRecord } from "@evilmartians/agent-prism-types";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";

import cn from "classnames";
import { useCallback } from "react";

import type { AvatarProps } from "../Avatar";
import type { BadgeProps } from "../Badge";
import type { ReadonlyProps } from "../ReadonlyProps";

import { Badge } from "../Badge";
import { PriceBadge } from "../PriceBadge";
import { TimestampBadge } from "../TimestampBadge";
import { TokensBadge } from "../TokensBadge";
import { TraceListItemHeader } from "./TraceListItemHeader";

type TraceListItemProps = {
  /** Row actions, rendered in the header next to the span badge */
  actions?: ReactNode | undefined;
  avatar?: Omit<AvatarProps, "ref"> | undefined;
  badges?: Omit<BadgeProps, "ref">[] | undefined;
  isSelected?: boolean | undefined;
  onClick?: (() => void) | undefined;
  showDescription?: boolean | undefined;
  trace: TraceRecord;
};

export const TraceListItem = ({
  actions,
  avatar,
  badges,
  isSelected,
  onClick,
  showDescription = true,
  trace,
}: ReadonlyProps<TraceListItemProps>): ReactElement => {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      // actions 插槽里的按钮（… 菜单）是这个 div 的后代；不挡一下的话，
      // 行上的 Enter/Space 会 preventDefault 掉按钮的默认激活行为，键盘用户打不开菜单。
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick?.();
      }
    },
    [onClick],
  );

  const { agentDescription, name, startTime, totalCost, totalTokens } = trace;

  return (
    <div
      aria-label={`Select trace ${name}`}
      className={cn(
        "group w-full",
        "flex flex-col gap-2 p-4",
        "cursor-pointer",
        isSelected === true
          ? "bg-agentprism-secondary/75 dark:bg-agentprism-muted/80"
          : "bg-agentprism-background hover:bg-agentprism-secondary/45 dark:hover:bg-agentprism-muted/70",
      )}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <TraceListItemHeader actions={actions} avatar={avatar} trace={trace} />

      <div className="flex flex-wrap items-center gap-2">
        {showDescription ? (
          <span className="text-agentprism-muted-foreground mr-4 max-w-full truncate text-sm">
            {agentDescription}
          </span>
        ) : null}

        {typeof totalCost === "number" && <PriceBadge cost={totalCost} />}

        {typeof totalTokens === "number" && (
          <TokensBadge tokensCount={totalTokens} />
        )}

        {badges?.map((badge, index) => (
          <Badge key={index} label={badge.label} size="4" />
        ))}

        {typeof startTime === "number" && (
          <TimestampBadge timestamp={startTime} />
        )}
      </div>
    </div>
  );
};
