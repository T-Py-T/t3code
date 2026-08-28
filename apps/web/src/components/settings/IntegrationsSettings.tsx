/**
 * Integrations settings - preferences for surfaces T3 Code embeds rather than
 * owns. Computer Use governs access to native applications; Browser controls
 * the defaults a preview tab opens at, applied to both hand-opened tabs and
 * agent `preview_open` calls that don't state their own size.
 *
 * @module IntegrationsSettings
 */
import {
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_VIEWPORT,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAppearancePreference,
  type PreviewAutomationStatus,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import {
  Globe2Icon,
  HistoryIcon,
  InfoIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ScreenRotationIcon } from "~/browser/ScreenRotationIcon";
import { isElectron } from "../../env";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const FILL_VALUE = "fill";
const RESPONSIVE_VALUE = "responsive";

/**
 * The size a "Responsive" default falls back to when the user switches away
 * from Fill and hasn't typed dimensions yet. Fill has no dimensions to carry
 * over, so the picker needs something concrete to seed the inputs with.
 */
const RESPONSIVE_SEED_SIZE = { width: 1280, height: 800 } as const;

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

const APPEARANCE_LABELS: Readonly<Record<PreviewAppearancePreference, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const zoomLabel = (zoomFactor: number) => `${Math.round(zoomFactor * 100)}%`;

const viewportSelectValue = (viewport: PreviewViewportSetting): string => {
  if (viewport._tag === "fill") return FILL_VALUE;
  if (
    viewport._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === viewport.presetId)
  ) {
    return viewport.presetId;
  }
  return RESPONSIVE_VALUE;
};

/**
 * The trigger renders this rather than a bare `SelectValue`, which would fall
 * back to printing the raw stored value ("fill") because the options are built
 * inline instead of from an `items` map.
 */
const viewportSelectLabel = (viewport: PreviewViewportSetting): string => {
  const value = viewportSelectValue(viewport);
  if (value === FILL_VALUE) return "Fill panel";
  if (value === RESPONSIVE_VALUE) return "Responsive";
  return PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ?? "Responsive";
};

const isValidDimension = (value: number) =>
  Number.isInteger(value) &&
  value >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
  value <= PREVIEW_VIEWPORT_MAX_DIMENSION;

/**
 * A sized viewport with width and height swapped. Presets keep their identity
 * through a rotation — `resolvePreviewViewport` already stores rotated presets
 * as the preset id plus swapped dimensions — so a rotated iPad is still an
 * iPad, not an anonymous custom size.
 */
const rotateViewport = (
  viewport: Exclude<PreviewViewportSetting, { readonly _tag: "fill" }>,
): PreviewViewportSetting => ({
  ...viewport,
  width: viewport.height,
  height: viewport.width,
});

function BrowserViewportSetting({ disabled }: { readonly disabled: boolean }) {
  const viewport = useClientSettings((settings) => settings.browserDefaultViewport);
  const updateSettings = useUpdatePrimarySettings();

  const sized = viewport._tag === "fill" ? null : viewport;
  const presentedSize = {
    width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
    height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
  };

  const selectViewport = (value: string | null) => {
    if (value === FILL_VALUE) {
      updateSettings({ browserDefaultViewport: FILL_PREVIEW_VIEWPORT });
      return;
    }
    if (value === RESPONSIVE_VALUE) {
      updateSettings({
        browserDefaultViewport: {
          _tag: "freeform",
          width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
          height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
        },
      });
      return;
    }
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) return;
    updateSettings({
      browserDefaultViewport: {
        _tag: "preset",
        width: preset.width,
        height: preset.height,
        presetId: preset.id,
      },
    });
  };

  // Committed on blur rather than per keystroke: typing "2560" passes through
  // "256", which is a legal dimension, so an onValueChange handler would
  // persist that intermediate size and churn the settings file on every key.
  const commitDimension = (axis: "width" | "height", value: number | null) => {
    if (value === null || !isValidDimension(value)) return;
    const next = { ...presentedSize, [axis]: value };
    if (next.width * next.height > PREVIEW_VIEWPORT_MAX_AREA) return;
    if (sized && next.width === sized.width && next.height === sized.height) return;
    // Typing a size means the preset no longer describes it.
    updateSettings({ browserDefaultViewport: { _tag: "freeform", ...next } });
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-default-viewport")}
      description="The viewport a browser tab opens at, for both you and agents. Fill sizes the page to the panel; any other choice opens the device toolbar at that size."
      resetAction={
        !disabled && viewport._tag !== DEFAULT_BROWSER_VIEWPORT._tag ? (
          <SettingResetButton
            label="default browser viewport"
            onClick={() => updateSettings({ browserDefaultViewport: DEFAULT_BROWSER_VIEWPORT })}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Select
            value={viewportSelectValue(viewport)}
            onValueChange={selectViewport}
            disabled={disabled}
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-44"
              aria-label="Default browser viewport"
            >
              <SelectValue>{viewportSelectLabel(viewport)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-64">
              <SelectItem value={FILL_VALUE}>Fill panel</SelectItem>
              <SelectItem value={RESPONSIVE_VALUE}>Responsive</SelectItem>
              <SelectGroup>
                <SelectGroupLabel>Standard</SelectGroupLabel>
                {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    <span className="flex w-full items-center justify-between gap-5">
                      <span>{preset.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {preset.detail}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>

          {sized ? (
            <div className="flex min-w-0 items-center gap-1">
              <NumberField
                value={presentedSize.width}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                // Pixel counts read as raw numbers; grouping would show "1,024".
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("width", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport width" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">×</span>
              <NumberField
                value={presentedSize.height}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("height", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport height" />
                </NumberFieldGroup>
              </NumberField>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={disabled}
                      aria-label={`Rotate to ${
                        presentedSize.height >= presentedSize.width ? "landscape" : "portrait"
                      }`}
                      onClick={() =>
                        updateSettings({ browserDefaultViewport: rotateViewport(sized) })
                      }
                    >
                      <ScreenRotationIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Rotate</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function BrowserZoomSetting({ disabled }: { readonly disabled: boolean }) {
  const zoomFactor = useClientSettings((settings) => settings.browserDefaultZoomFactor);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-zoom")}
      description="Page zoom applied to new browser tabs."
      resetAction={
        !disabled && zoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
          <SettingResetButton
            label="default browser zoom"
            onClick={() =>
              updateSettings({ browserDefaultZoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={String(zoomFactor)}
          onValueChange={(value) => {
            const next = PREVIEW_ZOOM_LEVELS.find((level) => String(level) === value);
            if (next !== undefined) updateSettings({ browserDefaultZoomFactor: next });
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser zoom">
            <SelectValue>{zoomLabel(zoomFactor)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {PREVIEW_ZOOM_LEVELS.map((level) => (
              <SelectItem hideIndicator key={level} value={String(level)}>
                {zoomLabel(level)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserAppearanceSetting({ disabled }: { readonly disabled: boolean }) {
  const appearance = useClientSettings((settings) => settings.browserDefaultAppearance);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-appearance")}
      description="The color scheme pages are told to prefer. System follows your OS setting."
      resetAction={
        !disabled && appearance !== DEFAULT_PREVIEW_APPEARANCE ? (
          <SettingResetButton
            label="default browser appearance"
            onClick={() => updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={appearance}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") {
              updateSettings({ browserDefaultAppearance: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser appearance">
            <SelectValue>{APPEARANCE_LABELS[appearance]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(APPEARANCE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function AgentBrowserAccessSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("agent-browser-access")}
      description="Let agents open and drive the preview browser. When off, the browser tools and the instructions describing them are withheld from agent sessions. Your own browser panel is unaffected."
      status={
        settings.enableAgentBrowserAccess
          ? undefined
          : "Applies to sessions started from now on; a running agent keeps the tools it was given."
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label="agent browser access"
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(checked) =>
            updateSettings({ enableAgentBrowserAccess: Boolean(checked) })
          }
          aria-label="Allow agent browser access"
        />
      }
    />
  );
}

function ExternalBrowserAccessSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [status, setStatus] = useState<PreviewAutomationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.externalBrowser;

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setStatus(await bridge.status());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read browser status.");
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openBrowser = async () => {
    if (!bridge) return;
    setPending(true);
    try {
      setStatus(
        await bridge.open({
          browser: "external",
          open: true,
          reuseExistingTab: true,
        }),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the browser.");
    } finally {
      setPending(false);
    }
  };

  const disconnect = async () => {
    if (!bridge) return;
    setPending(true);
    try {
      await bridge.close();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect the browser.");
    } finally {
      setPending(false);
    }
  };

  const statusText = !bridge
    ? "Available in the desktop app."
    : error
      ? error
      : status?.connectionState === "connected"
        ? `${status.profileName ?? "T3 Code browser"} is open and ready.`
        : status && !status.available
          ? "Install Chrome, Edge, Brave, or Chromium to use this feature."
          : settings.enableExternalBrowserAccess
            ? "Access enabled. Open the browser and sign in to the sites you want T3 Code to use."
            : "Off by default. This permission is separate from the in-app preview browser.";

  return (
    <SettingsRow
      {...searchableSetting("external-browser-access")}
      description="Let agents use a dedicated, persistent T3 Code browser profile for signed-in websites. It never attaches to your everyday Chrome profile, and disabling access closes the controlled browser."
      status={statusText}
      resetAction={
        settings.enableExternalBrowserAccess !==
        DEFAULT_UNIFIED_SETTINGS.enableExternalBrowserAccess ? (
          <SettingResetButton
            label="signed-in browser access"
            onClick={() => {
              updateSettings({
                enableExternalBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableExternalBrowserAccess,
              });
              void disconnect();
            }}
          />
        ) : null
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {settings.enableExternalBrowserAccess && bridge ? (
            status?.connectionState === "connected" ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={disconnect}>
                Disconnect
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={pending} onClick={openBrowser}>
                <Globe2Icon className="size-3" />
                Open browser
              </Button>
            )
          ) : null}
          <Switch
            disabled={!bridge}
            checked={settings.enableExternalBrowserAccess}
            onCheckedChange={(checked) => {
              const enabled = Boolean(checked);
              updateSettings({ enableExternalBrowserAccess: enabled });
              if (!enabled) void disconnect();
            }}
            aria-label="Allow signed-in external browser access"
          />
        </div>
      }
    />
  );
}

function AgentComputerUseSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("agent-computer-use")}
      description="Experimental preview. Let agents observe and operate approved applications on this computer. Native release signing and platform acceptance are still in progress."
      status={
        settings.enableComputerUse
          ? "Applies to sessions started from now on. Sensitive actions still require an approval."
          : "Computer tools are withheld from provider sessions."
      }
      resetAction={
        settings.enableComputerUse !== DEFAULT_UNIFIED_SETTINGS.enableComputerUse ? (
          <SettingResetButton
            label="agent computer use"
            onClick={() =>
              updateSettings({
                enableComputerUse: DEFAULT_UNIFIED_SETTINGS.enableComputerUse,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.enableComputerUse}
          onCheckedChange={(checked) => updateSettings({ enableComputerUse: Boolean(checked) })}
          aria-label="Allow agent computer use"
        />
      }
    />
  );
}

export function ComputerUseAccessControls() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const controlState = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.computerUseControlState({ environmentId, input: {} }),
  );
  const history = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.computerUseHistory({ environmentId, input: { limit: 50 } }),
  );
  const revokePersistentGrant = useAtomCommand(
    serverEnvironment.revokeComputerUsePersistentGrant,
    "remove Computer Use access",
  );
  const stopComputerUse = useAtomCommand(serverEnvironment.stopComputerUse, "stop Computer Use");
  const pauseComputerUse = useAtomCommand(serverEnvironment.pauseComputerUse, "pause Computer Use");
  const resumeComputerUse = useAtomCommand(
    serverEnvironment.resumeComputerUse,
    "resume Computer Use",
  );
  const clearHistory = useAtomCommand(
    serverEnvironment.clearComputerUseHistory,
    "clear Computer Use history",
  );
  const state = controlState.data;
  const permissionSummary = state?.status
    ? [
        `Accessibility ${state.status.permissions.accessibility}`,
        `Screen capture ${state.status.permissions.screenCapture}`,
        `Input monitoring ${state.status.permissions.input}`,
      ].join(" · ")
    : undefined;
  const status = state?.paused
    ? "paused"
    : state?.activeControl
      ? "active"
      : state?.host
        ? "connected"
        : "disconnected";
  const statusText = state?.paused
    ? "Computer Use is paused. Resume it before an agent can start another action."
    : state?.activeControl
      ? `${state.activeControl.providerInstanceId} is controlling this computer.`
      : state?.host
        ? `${state.host.platform === "macos" ? "Mac" : "Windows"} host connected and ready.`
        : controlState.isPending
          ? "Checking the native host…"
          : "Native computer host is not connected.";

  return (
    <div data-computer-use-status={status} className="space-y-1">
      <SettingsRow
        title="Host and current control"
        description="Shows whether the signed native helper is available and which agent currently holds control."
        status={
          controlState.error ? (
            <span className="text-destructive">{controlState.error}</span>
          ) : (
            statusText
          )
        }
        control={
          <div className="flex items-center gap-2">
            {state?.paused && environmentId ? (
              <Button
                size="sm"
                variant="outline"
                aria-label="Resume computer control"
                onClick={() => void resumeComputerUse({ environmentId, input: {} })}
              >
                <PlayIcon className="size-3" />
                Resume
              </Button>
            ) : null}
            {state?.activeControl && environmentId ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Pause computer control"
                  onClick={() => void pauseComputerUse({ environmentId, input: {} })}
                >
                  <PauseIcon className="size-3" />
                  Pause
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  aria-label="Stop computer control"
                  onClick={() => void stopComputerUse({ environmentId, input: {} })}
                >
                  <SquareIcon className="size-3" />
                  Stop
                </Button>
              </>
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Refresh computer use status"
              disabled={controlState.isPending}
              onClick={controlState.refresh}
            >
              <RefreshCwIcon
                className={controlState.isPending ? "size-3 animate-spin" : "size-3"}
              />
            </Button>
          </div>
        }
      >
        {state?.host ? (
          <div
            className="mt-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground"
            data-computer-use-permission-owner={state.host.verifiedIdentity.publisher}
            data-computer-use-permissions={permissionSummary}
          >
            <div>
              Permission owner: T3 Code Computer Use · {state.host.verifiedIdentity.publisher}
            </div>
            {permissionSummary ? <div className="mt-0.5">{permissionSummary}</div> : null}
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        title="Always allowed applications"
        description="Persistent approvals are tied to this verified computer and application identity. Removing one makes the next agent ask again."
        status={
          state && state.persistentGrants.length === 0
            ? "No applications have permanent access."
            : undefined
        }
      >
        {state?.persistentGrants.map((grant) => (
          <div
            key={`${grant.hostId}:${grant.target.stableIdentity}:${grant.access}`}
            data-computer-use-grant={`${grant.target.displayName}:${grant.access}`}
            className="mt-2 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <ShieldCheckIcon className="size-4 shrink-0 text-success" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{grant.target.displayName}</div>
                <div className="text-[11px] text-muted-foreground">
                  {grant.access === "operate" ? "Observe and operate" : "Observe only"}
                </div>
              </div>
            </div>
            {environmentId ? (
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={`Remove ${grant.target.displayName} computer access`}
                onClick={() =>
                  void revokePersistentGrant({
                    environmentId,
                    input: {
                      hostId: grant.hostId,
                      stableIdentity: grant.target.stableIdentity,
                    },
                  })
                }
              >
                <XIcon className="size-3" />
              </Button>
            ) : null}
          </div>
        ))}
      </SettingsRow>

      <SettingsRow
        title="Recent Computer Use activity"
        description="Keeps 30 days of bounded metadata: target, stage, result, provider, and time. Screenshots, page contents, accessibility trees, clipboard values, and typed text are never saved here."
        status={
          history.error ? (
            <span className="text-destructive">{history.error}</span>
          ) : history.data?.entries.length === 0 ? (
            "No Computer Use activity has been recorded."
          ) : undefined
        }
        control={
          history.data && history.data.entries.length > 0 && environmentId ? (
            <Button
              size="sm"
              variant="ghost-muted"
              aria-label="Clear Computer Use history"
              onClick={() => void clearHistory({ environmentId, input: {} })}
            >
              <Trash2Icon className="size-3" />
              Clear
            </Button>
          ) : null
        }
      >
        {history.data?.entries.map((entry) => (
          <div
            key={entry.entryId}
            data-computer-use-history={entry.state}
            className="mt-2 flex min-w-0 items-start gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
          >
            <HistoryIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{entry.summary}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                <span>{entry.state.replaceAll("-", " ")}</span>
                {entry.providerInstanceId ? <span>{entry.providerInstanceId}</span> : null}
                <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
              </div>
            </div>
          </div>
        ))}
      </SettingsRow>
    </div>
  );
}

function BrowserAutoShowFloatingPreviewSetting({ disabled }: { readonly disabled: boolean }) {
  const autoShow = useClientSettings((settings) => settings.browserAutoShowFloatingPreview);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-auto-show-floating-preview")}
      description="Pop the floating preview into view when an agent opens a browser. An agent that explicitly asks to show or hide its preview still gets what it asked for."
      resetAction={
        !disabled && autoShow !== DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW ? (
          <SettingResetButton
            label="auto-show floating preview"
            onClick={() =>
              updateSettings({
                browserAutoShowFloatingPreview: DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          disabled={disabled}
          checked={autoShow}
          onCheckedChange={(checked) =>
            updateSettings({ browserAutoShowFloatingPreview: Boolean(checked) })
          }
          aria-label="Auto-show floating preview"
        />
      }
    />
  );
}

/**
 * Frames the client-local preview defaults as one unavailable block.
 *
 * Disabling each control on its own left the labels and descriptions at full
 * strength, so the group still read as editable. Boxing it puts the reason at
 * the top and dims everything it covers, which is also why the explanation
 * sits outside the dimmed area — the one part that must stay readable is the
 * part saying why the rest isn't.
 *
 * Disabled rather than hidden because these are *client* settings: editing
 * them from a browser tab would write preferences belonging to a different
 * client, reading as though the desktop app had been configured when it
 * hadn't.
 */
function DesktopOnlyBrowserDefaults({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 py-1.5">
      <div className="flex items-start gap-2 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>Only available in the desktop app.</p>
      </div>
      <div className="[&_h3]:opacity-64 [&_p]:opacity-64">{children}</div>
    </div>
  );
}

export function IntegrationsSettingsPanel() {
  // Client-local preview defaults are editable only where the preview exists.
  const previewDefaultsDisabled = !isElectron;
  const previewDefaults = (
    <>
      <BrowserViewportSetting disabled={previewDefaultsDisabled} />
      <BrowserZoomSetting disabled={previewDefaultsDisabled} />
      <BrowserAppearanceSetting disabled={previewDefaultsDisabled} />
      <BrowserAutoShowFloatingPreviewSetting disabled={previewDefaultsDisabled} />
    </>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="computer-use" title="Computer Use (preview)">
        <AgentComputerUseSetting />
        <ComputerUseAccessControls />
      </SettingsSection>
      <SettingsSection id="browser" title="Browser">
        {/* Server-authoritative, so it stays editable on every client and sits
            outside the block covering the desktop-only defaults. */}
        <AgentBrowserAccessSetting />
        <ExternalBrowserAccessSetting />
        {previewDefaultsDisabled ? (
          <DesktopOnlyBrowserDefaults>{previewDefaults}</DesktopOnlyBrowserDefaults>
        ) : (
          previewDefaults
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
