/**
 * ISIT design system.
 *
 * Every component here is PRESENTATIONAL: props in, DOM out, no data fetching,
 * no knowledge of HL7 / FHIR / CDA / SOAP. Sibling agents should import from
 * "../ui" and hand these components data shaped by `./types`.
 */

export { cx } from "./cx";

export * from "./types";
export {
  SEV_TEXT,
  SEV_CHIP,
  SEV_RULE,
  SEV_UNDERLINE,
  SEV_DOT,
  IGNORED_EXPLANATION,
} from "./severity";

export { Badge, SeverityTag, UsageBadge, UsageRuleList } from "./Badge";
export type {
  BadgeProps,
  SeverityTagProps,
  UsageBadgeProps,
  UsageRuleListProps,
} from "./Badge";

export { Button } from "./Button";
export type { ButtonProps } from "./Button";

export { CopyButton } from "./CopyButton";
export type { CopyButtonProps } from "./CopyButton";

export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";

export { FindingRow } from "./FindingRow";
export type { FindingRowProps } from "./FindingRow";

export { KeyDialog, useApiKey, maskKey, API_KEY_STORAGE_KEY } from "./KeyDialog";
export type { KeyDialogProps } from "./KeyDialog";

export { SourceNote } from "./SourceNote";
export type { SourceNoteProps } from "./SourceNote";

export {
  SplitView,
  CODE_LINE_HEIGHT,
} from "./SplitView";
export type {
  SplitViewProps,
  SplitSelection,
  SelectionOrigin,
} from "./SplitView";

export {
  StatusDot,
  UseCaseStatusDot,
  SeverityCount,
  USE_CASE_STATUS_META,
} from "./StatusDot";
export type {
  StatusDotProps,
  UseCaseStatusDotProps,
  SeverityCountProps,
} from "./StatusDot";

export { StructureTree, TREE_ROW_HEIGHT } from "./StructureTree";
export type { StructureTreeProps } from "./StructureTree";

export { Tabs } from "./Tabs";
export type { TabsProps, TabItem } from "./Tabs";

export { ThemeToggle } from "./ThemeToggle";
export type { ThemeToggleProps } from "./ThemeToggle";

export { Toast, ToastProvider, ToastViewport, useToast } from "./Toast";
export type { ToastMessage } from "./Toast";

export { Toolbar, ToolbarTitle, ToolbarDivider } from "./Toolbar";
export type { ToolbarProps } from "./Toolbar";

export { Tooltip } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";

export { UseCaseRail } from "./UseCaseRail";
export type { UseCaseRailProps, UseCaseRailHandle } from "./UseCaseRail";

export { useTheme } from "./useTheme";
export type { ThemeChoice } from "./useTheme";

export { useVirtualRows } from "./useVirtualRows";
export type { VirtualWindow, UseVirtualRowsOptions } from "./useVirtualRows";

export { useDensity } from "./useDensity";
export type { DensityChoice } from "./useDensity";

export { DensityToggle } from "./DensityToggle";
export type { DensityToggleProps } from "./DensityToggle";

/* Chart primitives: hand-written SVG, format-agnostic, colour reserved like everything else. */
export * from "./charts";
