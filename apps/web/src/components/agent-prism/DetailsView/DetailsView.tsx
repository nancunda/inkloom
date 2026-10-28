import type { DeepReadonly, TraceSpan } from "@evilmartians/agent-prism-types";
import type { ReactElement, ReactNode } from "react";

import {
  hasContextContent,
  hasThinkingContent,
} from "@evilmartians/agent-prism-data";
import cn from "classnames";
import {
  ArrowRightLeft,
  Brain,
  Gauge,
  SquareTerminal,
  Tags,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import type { AvatarProps } from "../Avatar";
import type { ReadonlyProps } from "../ReadonlyProps";
import type { TabItem } from "../Tabs";
import type { DetailsViewHeaderProps } from "./DetailsViewHeader";

import { TabSelector } from "../TabSelector";
import { DetailsViewAttributesTab } from "./DetailsViewAttributesTab";
import { DetailsViewContextTab } from "./DetailsViewContextTab";
import { DetailsViewHeader } from "./DetailsViewHeader";
import { DetailsViewInputOutputTab } from "./DetailsViewInputOutputTab";
import { DetailsViewRawDataTab } from "./DetailsViewRawDataTab";
import { DetailsViewThinkingTab } from "./DetailsViewThinkingTab";

export type DetailsViewProps = {
  /**
   * All spans of the selected trace. When provided, enables run-level error
   * blocks in the Input/Output tab (a run summary when the root span is
   * selected, otherwise the selected span's own error).
   */
  allSpans?: TraceSpan[] | undefined;

  /**
   * Optional avatar configuration for the header
   */
  avatar?: Omit<AvatarProps, "ref"> | undefined;

  /**
   * Optional className for the root container
   */
  className?: string | undefined;

  /**
   * Configuration for the copy button functionality
   */
  copyButton?: DetailsViewHeaderProps["copyButton"];

  /**
   * Optional custom header component to replace the default
   */
  customHeader?:
    | ((props: Readonly<{ data: ReadonlySpan }>) => ReactNode)
    | ReactNode
    | undefined;

  /**
   * The span data to display in the details view
   */
  data: TraceSpan;

  /**
   * The initially selected tab. Ignored when `tab` is provided.
   */
  defaultTab?: DetailsViewTab | undefined;

  /**
   * The selected tab, when the caller controls it (e.g. a toolbar button that
   * jumps straight to the "plan" tab). Omit to keep the tab internal.
   */
  tab?: DetailsViewTab | undefined;

  /**
   * Extra tabs appended after the built-in ones, before RAW. Used by inkloom
   * to add a per-session "计划" tab.
   */
  extraTabs?: DetailsViewExtraTab[] | undefined;

  /**
   * Custom header actions to render
   * Can be a ReactNode or a render function that receives the data
   */
  headerActions?: ((data: ReadonlySpan) => ReactNode) | ReactNode | undefined;

  /**
   * Callback fired when the active tab changes, including when the current tab
   * isn't available for a new span and the view falls back to the first tab
   */
  onTabChange?: ((tabValue: DetailsViewTab) => void) | undefined;
};

export type DetailsViewExtraTab = {
  /** Stable identifier, also used as the tab value */
  key: string;
  title: string;
  content: ReactNode;
  icon?: ReactNode | undefined;
};

/**
 * Built-in tab ids, plus any id coming from `extraTabs`. The
 * `(string & {})` branch keeps literal autocomplete for the built-ins while
 * letting callers pass their own keys.
 */
type DetailsViewTab =
  | "attributes"
  | "context"
  | "input-output"
  | "raw"
  | "thinking"
  | (string & {});

type ReadonlySpan = DeepReadonly<TraceSpan>;

/**
 * Tabs are content-aware. Thinking is offered for any span that reports
 * reasoning, whatever the vendor, even when only a reasoning-token count is
 * known.
 */
const BUILTIN_TABS = ["attributes", "context", "input-output", "raw", "thinking"] as const;

const getTabItems = (
  data: ReadonlySpan,
  extraTabs: readonly DetailsViewExtraTab[],
): TabItem<DetailsViewTab>[] => [
  {
    icon: <ArrowRightLeft className="size-4" />,
    label: "In/Out",
    value: "input-output",
  },
  ...(hasThinkingContent(data)
    ? [
        {
          icon: <Brain className="size-4" />,
          label: "Thinking",
          value: "thinking" as const,
        },
      ]
    : []),
  ...(hasContextContent(data)
    ? [
        {
          icon: <Gauge className="size-4" />,
          label: "Context",
          value: "context" as const,
        },
      ]
    : []),
  {
    icon: <Tags className="size-4" />,
    label: "Attributes",
    value: "attributes",
  },
  ...extraTabs
    // 与内置 id 撞名会让同一个 tab 渲染两份内容，直接忽略
    .filter((tab) => !(BUILTIN_TABS as readonly string[]).includes(tab.key))
    .map((tab) => ({
      ...(tab.icon === undefined ? {} : { icon: tab.icon }),
      label: tab.title,
      value: tab.key,
    })),
  {
    icon: <SquareTerminal className="size-4" />,
    label: "RAW",
    value: "raw",
  },
];

export const DetailsView = ({
  allSpans,
  avatar,
  className,
  copyButton,
  customHeader,
  data,
  defaultTab = "input-output",
  extraTabs = [],
  headerActions,
  onTabChange,
  tab: controlledTab,
}: ReadonlyProps<DetailsViewProps>): ReactElement => {
  const [innerTab, setInnerTab] = useState<DetailsViewTab>(defaultTab);
  const tab = controlledTab ?? innerTab;

  const tabItems = useMemo(() => getTabItems(data, extraTabs), [data, extraTabs]);

  useEffect(() => {
    if (tabItems.some((item) => item.value === tab)) return;
    const fallbackTab = tabItems[0]?.value ?? defaultTab;
    if (controlledTab === undefined) setInnerTab(fallbackTab);
    onTabChange?.(fallbackTab);
  }, [tabItems, tab, defaultTab, controlledTab, onTabChange]);

  const handleTabChange = (tabValue: DetailsViewTab) => {
    if (controlledTab === undefined) setInnerTab(tabValue);
    onTabChange?.(tabValue);
  };

  const resolvedHeaderActions =
    typeof headerActions === "function" ? headerActions(data) : headerActions;

  const hasCustomHeader = Boolean(customHeader);
  const headerContent = hasCustomHeader ? (
    typeof customHeader === "function" ? (
      customHeader({ data })
    ) : (
      customHeader
    )
  ) : (
    <DetailsViewHeader
      actions={resolvedHeaderActions}
      avatar={avatar}
      copyButton={copyButton}
      data={data}
    />
  );

  return (
    <div
      className={cn(
        "border-agentprism-border bg-agentprism-background flex h-full min-h-0 flex-col rounded-md border p-4",
        className,
      )}
    >
      <div className="mb-4 shrink-0">{headerContent}</div>
      <div className="shrink-0">
        <TabSelector
          defaultValue={defaultTab}
          items={tabItems}
          onValueChange={handleTabChange}
          theme="underline"
          value={tab}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-4" key={tab}>
        {tab === "input-output" && (
          <DetailsViewInputOutputTab allSpans={allSpans} data={data} />
        )}
        {tab === "thinking" && <DetailsViewThinkingTab data={data} />}
        {tab === "context" && <DetailsViewContextTab data={data} />}
        {tab === "attributes" && <DetailsViewAttributesTab data={data} />}
        {tab === "raw" && <DetailsViewRawDataTab data={data} />}
        {extraTabs
          .filter((item) => item.key === tab && !(BUILTIN_TABS as readonly string[]).includes(item.key))
          .map((item) => (
            <Fragment key={item.key}>{item.content}</Fragment>
          ))}
      </div>
    </div>
  );
};
