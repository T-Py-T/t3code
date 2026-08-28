import * as Haptics from "expo-haptics";
import type { ComputerUseScreenshotRevealToken, EnvironmentId } from "@t3tools/contracts";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { Image, LayoutAnimation, Pressable, ScrollView, View } from "react-native";
import { useState } from "react";

import { AppText as Text } from "../../components/AppText";
import { scaledTypographyLineHeight } from "../../lib/appearancePreferences";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useThemeColor } from "../../lib/useThemeColor";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import Animated, { FadeIn } from "react-native-reanimated";

const WORK_LOG_LAYOUT_ANIMATION = {
  duration: 180,
  create: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
} as const;

function triggerDisclosureFeedback() {
  LayoutAnimation.configureNext(WORK_LOG_LAYOUT_ANIMATION);
  void Haptics.selectionAsync();
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

// Tool-like activities with a neutral status carry no signal worth a row.
export function visibleWorkLogActivities(
  activities: ReadonlyArray<ThreadFeedActivity>,
): ReadonlyArray<ThreadFeedActivity> {
  return activities.filter((activity) => !(activity.toolLike && activity.status === "neutral"));
}

// Pre-measurement heights for the feed's getFixedItemSize. Collapsed work-log
// rows are single-line (numberOfLines={1}) inside a min-height that stays
// taller than the text at every supported base font size (text-xs reaches
// 23px at the 22pt maximum, under the 32px min-h-8), so row height is
// deterministic. The "work log" label has no such clamp — its height follows
// the scaled text-2xs line height. Values mirror the classNames below — keep
// them in sync; a mismatch only costs a one-time correction on measure.
const WORK_ROW_HEIGHT = 32; // min-h-8
const COMPUTER_USE_ROW_HEIGHT = 172; // min-h-[172px]
const WORK_ROW_GAP = 1; // gap-px
const WORK_LOG_HEADER_PADDING = 2; // pb-0.5 under the "work log" label
const WORK_LOG_BOTTOM_MARGIN = 4; // mb-1

export const WORK_GROUP_TOGGLE_HEIGHT = 36; // min-h-8 (32) + mb-1 (4)

export function collapsedWorkLogHeight(
  activities: ReadonlyArray<ThreadFeedActivity>,
  baseFontSize: number,
): number {
  const rows = visibleWorkLogActivities(activities);
  if (rows.length === 0) {
    return 0;
  }
  const showsHeader = rows.some((row) => !row.toolLike && !row.computerUse);
  const headerHeight =
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.caption, baseFontSize) + WORK_LOG_HEADER_PADDING;
  return (
    WORK_LOG_BOTTOM_MARGIN +
    (showsHeader ? headerHeight : 0) +
    rows.reduce(
      (height, row) => height + (row.computerUse ? COMPUTER_USE_ROW_HEIGHT : WORK_ROW_HEIGHT),
      0,
    ) +
    (rows.length - 1) * WORK_ROW_GAP
  );
}

function ComputerUseActionButton(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      className={cn(
        "min-h-9 items-center justify-center rounded-lg border px-3 active:opacity-60",
        props.destructive ? "border-rose-500/40" : "border-border bg-subtle",
      )}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-xs font-t3-medium",
          props.destructive ? "text-rose-600 dark:text-rose-400" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function ComputerUseWorkRow(props: {
  readonly activity: ThreadFeedActivity;
  readonly environmentId: EnvironmentId;
}) {
  const iconColor = useThemeColor("--color-foreground-muted");
  const pauseComputerUse = useAtomCommand(serverEnvironment.pauseComputerUse, "pause Computer Use");
  const stopComputerUse = useAtomCommand(serverEnvironment.stopComputerUse, "stop Computer Use");
  const takeOverComputerUse = useAtomCommand(
    serverEnvironment.takeOverComputerUse,
    "take over Computer Use",
  );
  const resumeComputerUse = useAtomCommand(
    serverEnvironment.resumeComputerUse,
    "resume Computer Use",
  );
  const state = props.activity.computerUse;
  if (!state) return null;
  const active =
    state.state === "requested" ||
    state.state === "waiting-approval" ||
    state.state === "observing" ||
    state.state === "acting";
  const resumeRequired =
    state.state === "paused" || state.state === "stopped" || state.state === "taken-over";
  const stateLabel = state.state.replaceAll("-", " ");

  return (
    <View
      className="min-h-[172px] rounded-xl border border-border bg-card px-3 py-2.5"
      accessibilityLabel={`Computer Use ${stateLabel}`}
    >
      <View className="flex-row items-center gap-2">
        <View className="h-7 w-7 items-center justify-center rounded-lg bg-subtle">
          <SymbolView
            name={
              state.operation === "observe"
                ? { ios: "eye", android: "visibility" }
                : { ios: "square.and.pencil", android: "edit" }
            }
            size={14}
            tintColor={iconColor}
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-sm text-foreground">Computer Use</Text>
        <View className="rounded-full border border-border px-2 py-0.5">
          <Text className="text-3xs font-t3-bold uppercase text-foreground-muted">
            {stateLabel}
          </Text>
        </View>
      </View>
      <Text className="mt-1.5 text-sm text-foreground" numberOfLines={1}>
        {props.activity.summary}
      </Text>
      <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={1}>
        {[
          state.target?.displayName,
          state.providerInstanceId,
          state.hostId ? `host ${state.hostId}` : null,
          state.risk?.replaceAll("-", " "),
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={1}>
        {[
          state.workflowRunId ? `workflow ${state.workflowRunId}` : null,
          state.workflowStageId ? `stage ${state.workflowStageId}` : null,
          state.observationId ? `observation ${state.observationId}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {state.screenshotRevealToken ? (
        <ComputerUseScreenshotReveal
          environmentId={props.environmentId}
          token={state.screenshotRevealToken}
        />
      ) : null}
      {active ? (
        <View className="mt-2 flex-row justify-end gap-2 border-t border-border pt-2">
          <ComputerUseActionButton
            label="Pause"
            onPress={() => void pauseComputerUse({ environmentId: props.environmentId, input: {} })}
          />
          <ComputerUseActionButton
            label="Stop"
            destructive
            onPress={() => void stopComputerUse({ environmentId: props.environmentId, input: {} })}
          />
          <ComputerUseActionButton
            label="Take over"
            onPress={() =>
              void takeOverComputerUse({ environmentId: props.environmentId, input: {} })
            }
          />
        </View>
      ) : resumeRequired ? (
        <View className="mt-2 flex-row justify-end border-t border-border pt-2">
          <ComputerUseActionButton
            label="Allow a new action"
            onPress={() =>
              void resumeComputerUse({ environmentId: props.environmentId, input: {} })
            }
          />
        </View>
      ) : null}
    </View>
  );
}

function ComputerUseScreenshotReveal(props: {
  readonly environmentId: EnvironmentId;
  readonly token: ComputerUseScreenshotRevealToken;
}) {
  const [reveal, setReveal] = useState(false);
  const screenshot = useEnvironmentQuery(
    reveal
      ? serverEnvironment.computerUseScreenshot({
          environmentId: props.environmentId,
          input: { token: props.token },
        })
      : null,
  );
  if (!reveal) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reveal Computer Use screenshot"
        className="mt-2 self-start rounded-lg border border-border bg-subtle px-3 py-2 active:opacity-60"
        onPress={() => setReveal(true)}
      >
        <Text className="text-xs font-t3-medium text-foreground">Reveal screenshot</Text>
      </Pressable>
    );
  }
  if (screenshot.data?.screenshot) {
    const image = screenshot.data.screenshot;
    return (
      <Image
        accessibilityLabel="Computer Use observation"
        className="mt-2 h-36 w-full rounded-lg border border-border"
        resizeMode="contain"
        source={{ uri: `data:${image.mimeType};base64,${image.base64}` }}
      />
    );
  }
  return (
    <Text className="mt-2 text-xs text-foreground-muted">
      {screenshot.error ?? (screenshot.isPending ? "Loading screenshot…" : "Screenshot expired.")}
    </Text>
  );
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly environmentId: EnvironmentId;
  readonly copiedRowId: string | null;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string) => void;
}) {
  const pressedBackground = useThemeColor("--color-subtle");
  const rows = visibleWorkLogActivities(props.activities).map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));

  if (rows.length === 0) {
    return null;
  }

  const showsHeader = rows.some((row) => !row.toolLike && !row.computerUse);

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      {showsHeader ? (
        <Text className="px-0.5 pb-0.5 font-t3-medium text-2xs text-foreground-muted opacity-60">
          work log
        </Text>
      ) : null}

      <View className="gap-px">
        {rows.map((row) => {
          if (row.computerUse) {
            return (
              <ComputerUseWorkRow key={row.id} activity={row} environmentId={props.environmentId} />
            );
          }
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.canExpand;
          const fullDetail = expanded ? row.getFullDetail() : null;
          const displayText = row.detail ? `${row.summary} ${row.detail}` : row.summary;
          const iconIsDestructive = row.icon === "alert" || row.icon === "warning";

          return (
            <Animated.View
              key={row.id}
              {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
            >
              <Pressable
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityLabel={displayText}
                accessibilityHint={
                  canExpand
                    ? "Double tap to show full details. Long press to copy."
                    : "Long press to copy."
                }
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={4}
                onPress={() => {
                  if (canExpand) {
                    triggerDisclosureFeedback();
                    props.onToggleRow(row.id);
                  }
                }}
                onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackground : "transparent",
                })}
                className="rounded-md px-0.5 py-0"
              >
                <View className="min-h-8 flex-row items-center gap-1.5">
                  <View className="h-[18px] w-5 shrink-0 items-center justify-center">
                    <SymbolView
                      name={workRowSymbolName(row.icon)}
                      size={13}
                      weight="medium"
                      tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
                      type="monochrome"
                    />
                  </View>

                  <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
                    <Text
                      className={cn(
                        "font-t3-medium text-foreground",
                        iconIsDestructive && "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {row.summary}
                    </Text>
                    {row.detail ? (
                      <Text className="text-foreground-muted opacity-60"> {row.detail}</Text>
                    ) : null}
                  </Text>

                  <View className="shrink-0 flex-row items-center gap-px">
                    {props.copiedRowId === row.id ? (
                      <Text className="pr-1 font-t3-medium text-3xs text-emerald-600 dark:text-emerald-400">
                        Copied
                      </Text>
                    ) : null}
                    <View className="h-4 w-4 items-center justify-center">
                      {canExpand ? (
                        <SymbolView
                          name={
                            expanded
                              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                              : { ios: "chevron.down", android: "keyboard_arrow_down" }
                          }
                          size={11}
                          tintColor={props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                    <View className="h-4 w-4 items-center justify-center">
                      {row.status ? (
                        <SymbolView
                          name={
                            row.status === "failure"
                              ? { ios: "xmark", android: "close" }
                              : row.status === "success"
                                ? { ios: "checkmark", android: "check" }
                                : { ios: "minus", android: "remove" }
                          }
                          size={11}
                          tintColor={row.status === "failure" ? "#e11d48" : props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              </Pressable>

              {fullDetail ? (
                <View className="ml-7 border-l border-neutral-300/60 pb-1 pl-3 pt-0.5 dark:border-white/[0.12]">
                  <ScrollView
                    nestedScrollEnabled
                    directionalLockEnabled
                    showsVerticalScrollIndicator
                    className="max-h-60"
                    contentContainerStyle={{ paddingRight: 8 }}
                  >
                    <Text
                      selectable
                      className="font-mono text-2xs leading-normal text-foreground-muted"
                    >
                      {fullDetail}
                    </Text>
                  </ScrollView>
                </View>
              ) : null}
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

export function ThreadWorkGroupToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onlyToolActivities: boolean;
  readonly onToggle: () => void;
}) {
  const pressedBackground = useThemeColor("--color-subtle");
  const noun = props.onlyToolActivities
    ? props.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : props.hiddenCount === 1
      ? "log entry"
      : "log entries";
  const collapsedLabel = `Show ${props.hiddenCount} previous ${noun}`;
  const expandedLabel = props.onlyToolActivities
    ? "Show fewer tool calls"
    : "Show fewer log entries";

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={props.expanded ? expandedLabel : collapsedLabel}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        style={({ pressed }) => ({
          backgroundColor: pressed ? pressedBackground : "transparent",
        })}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5 py-0"
      >
        <View className="h-[18px] w-5 items-center justify-center">
          <SymbolView
            name={
              props.expanded
                ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                : { ios: "chevron.down", android: "keyboard_arrow_down" }
            }
            size={12}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-xs text-foreground opacity-80">
          {props.expanded ? expandedLabel : `+${props.hiddenCount} previous ${noun}`}
        </Text>
      </Pressable>
    </View>
  );
}
