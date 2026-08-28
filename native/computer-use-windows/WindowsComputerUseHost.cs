using System.Collections.Concurrent;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace T3Code.ComputerUse.Windows;

public sealed class WindowsComputerUseHost : IDisposable
{
    private const int MaximumAccessibilityElements = 5_000;
    private static readonly SyntheticInputTracker InputTracker = new();
    private readonly ConcurrentDictionary<string, byte> _cancelledLeases;
    private readonly Dictionary<string, ObservationRecord> _observations = new(
        StringComparer.Ordinal
    );
    private bool _disposed;

    public WindowsComputerUseHost(ConcurrentDictionary<string, byte> cancelledLeases)
    {
        _cancelledLeases = cancelledLeases;
    }

    public HostResponse Handle(HostRequest request)
    {
        try
        {
            var result = request.Operation switch
            {
                "status" => Status(),
                "listTargets" => ListTargets(request),
                "observe" => Observe(request),
                "act" => Act(request),
                _ => throw HostFailure.Unsupported(request.Operation),
            };
            return HostResponse.Success(request, result);
        }
        catch (HostFailure failure)
        {
            ReleaseSyntheticInput();
            return HostResponse.Failure(request, failure.Payload);
        }
        catch (Exception error)
        {
            ReleaseSyntheticInput();
            return HostResponse.Failure(
                request,
                HostErrorPayload.Create(
                    "ComputerUseUnsupportedOperationError",
                    "The Windows helper could not complete the operation.",
                    new JsonObject { ["exception"] = error.GetType().Name }
                )
            );
        }
        finally
        {
            _cancelledLeases.TryRemove(request.LeaseId, out _);
        }
    }

    private static JsonObject Status()
    {
        var result = new JsonObject
        {
            ["locked"] = DesktopIsLocked(),
            ["permissions"] = new JsonObject
            {
                ["accessibility"] = "not-required",
                ["screenCapture"] = "not-required",
                ["input"] = "not-required",
            },
        };
        var foreground = NativeMethods.GetForegroundWindow();
        var foregroundTarget = DiscoverTargets().FirstOrDefault(target => target.Handle == foreground);
        if (foregroundTarget is not null)
        {
            result["foregroundTargetId"] = foregroundTarget.TargetId;
        }

        return result;
    }

    private static JsonObject ListTargets(HostRequest request)
    {
        var requestedKind = request.Input.TryGetProperty("kind", out var kindValue)
            && kindValue.ValueKind == JsonValueKind.String
            ? kindValue.GetString()
            : null;
        return new JsonObject
        {
            ["targets"] = new JsonArray(
                DiscoverTargets()
                    .Where(target =>
                        TargetPolicy.MatchesRequestedKind(requestedKind, target.Classification.Kind)
                    )
                    .Select(target => (JsonNode?)target.ToJson())
                    .ToArray()
            ),
        };
    }

    private JsonObject Observe(HostRequest request)
    {
        var targetId = request.TargetId ?? throw HostFailure.Malformed("targetId");
        if (DesktopIsLocked())
        {
            throw HostFailure.LockChanged();
        }

        var target = RequireTarget(targetId);
        var includeScreenshot = OptionalBoolean(request.Input, "includeScreenshot", true);
        var includeAccessibility = OptionalBoolean(request.Input, "includeAccessibility", true);
        var screenshot = includeScreenshot ? Capture(target) : null;
        var (elements, indexedElements) = includeAccessibility
            ? ReadAccessibility(target)
            : (new JsonArray(), new Dictionary<string, AutomationElement>(StringComparer.Ordinal));
        var observationId = $"windows-observation-{Environment.ProcessId}-{Guid.NewGuid():N}";
        foreach (
            var staleId in _observations
                .Where(entry => entry.Value.Target.TargetId == target.TargetId)
                .Select(entry => entry.Key)
                .ToArray()
        )
        {
            _observations.Remove(staleId);
        }

        _observations[observationId] = new ObservationRecord(target, indexedElements);
        var result = new JsonObject
        {
            ["observationId"] = observationId,
            ["target"] = target.ToJson(),
            ["capturedAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["width"] = target.Bounds.Width,
            ["height"] = target.Bounds.Height,
            ["elements"] = elements,
        };
        if (screenshot is not null)
        {
            result["screenshot"] = screenshot;
        }

        return result;
    }

    private JsonObject Act(HostRequest request)
    {
        var targetId = request.TargetId ?? throw HostFailure.Malformed("targetId");
        var observationId = request.ObservationId ?? throw HostFailure.Malformed("observationId");
        if (!_observations.Remove(observationId, out var observation))
        {
            throw HostFailure.Stale();
        }

        var target = RequireTarget(targetId);
        if (
            observation.Target.TargetId != target.TargetId
            || observation.Target.StableIdentity != target.StableIdentity
        )
        {
            throw HostFailure.IdentityChanged();
        }

        if (observation.Target.Bounds != target.Bounds)
        {
            throw HostFailure.Stale();
        }

        if (
            !request.Input.TryGetProperty("actions", out var actions)
            || actions.ValueKind != JsonValueKind.Array
            || actions.GetArrayLength() is < 1 or > 64
        )
        {
            throw HostFailure.Malformed("actions");
        }

        Focus(target);
        var completed = 0;
        try
        {
            foreach (var action in actions.EnumerateArray())
            {
                RequireActive(request.LeaseId);
                Perform(action, target, observation, request.LeaseId);
                completed++;
            }
        }
        finally
        {
            ReleaseSyntheticInput();
        }

        var observeInput = JsonSerializer.SerializeToElement(
            new { includeScreenshot = true, includeAccessibility = true }
        );
        var fresh = Observe(
            request with
            {
                Operation = "observe",
                ObservationId = null,
                Input = observeInput,
            }
        );
        return new JsonObject { ["completedActions"] = completed, ["observation"] = fresh };
    }

    private void Perform(
        JsonElement action,
        TargetRecord target,
        ObservationRecord observation,
        string leaseId
    )
    {
        var tag = RequiredString(action, "_tag");
        switch (tag)
        {
            case "click":
            case "double-click":
            case "secondary-click":
                {
                    var point = TargetPoint(action, target);
                    SetCursor(point);
                    var secondary = tag == "secondary-click";
                    var clicks = tag == "double-click" ? 2 : 1;
                    for (var click = 0; click < clicks; click++)
                    {
                        SendMouse(
                            secondary ? MouseEventFlags.RightDown : MouseEventFlags.LeftDown,
                            0
                        );
                        SendMouse(secondary ? MouseEventFlags.RightUp : MouseEventFlags.LeftUp, 0);
                        if (click + 1 < clicks)
                        {
                            Thread.Sleep(40);
                        }
                    }

                    return;
                }
            case "move":
                {
                    NativeMethods.GetCursorPos(out var current);
                    MoveCursor(
                        current,
                        TargetPoint(action, target),
                        OptionalInteger(action, "durationMs", 0),
                        leaseId
                    );
                    return;
                }
            case "drag":
                {
                    var from = RequiredObject(action, "from");
                    var to = RequiredObject(action, "to");
                    var start = TargetPoint(from, target);
                    var end = TargetPoint(to, target);
                    SetCursor(start);
                    SendMouse(MouseEventFlags.LeftDown, 0);
                    try
                    {
                        MoveCursor(
                            start,
                            end,
                            OptionalInteger(action, "durationMs", 0),
                            leaseId
                        );
                    }
                    finally
                    {
                        SendMouse(MouseEventFlags.LeftUp, 0);
                    }

                    return;
                }
            case "scroll":
                {
                    if (action.TryGetProperty("x", out _) && action.TryGetProperty("y", out _))
                    {
                        SetCursor(TargetPoint(action, target));
                    }

                    var deltaY = RequiredInteger(action, "deltaY");
                    var deltaX = RequiredInteger(action, "deltaX");
                    if (deltaY != 0)
                    {
                        SendMouse(MouseEventFlags.Wheel, unchecked((uint)deltaY));
                    }

                    if (deltaX != 0)
                    {
                        SendMouse(MouseEventFlags.HorizontalWheel, unchecked((uint)deltaX));
                    }

                    return;
                }
            case "text-entry":
                TypeUnicode(OptionalString(action, "text", string.Empty));
                return;
            case "paste":
                Paste(OptionalString(action, "text", string.Empty));
                return;
            case "keypress":
                Keypress(
                    RequiredString(action, "key"),
                    OptionalStrings(action, "modifiers"),
                    OptionalString(action, "phase", "press")
                );
                return;
            case "selection":
                SelectText(action, observation);
                return;
            case "direct-value":
                SetDirectValue(action, observation);
                return;
            case "accessibility-action":
                RunAccessibilityAction(action, observation);
                return;
            case "wait":
                {
                    var remaining = Math.Clamp(RequiredInteger(action, "durationMs"), 0, 60_000);
                    while (remaining > 0)
                    {
                        RequireActive(leaseId);
                        var slice = Math.Min(remaining, 25);
                        Thread.Sleep(slice);
                        remaining -= slice;
                    }

                    return;
                }
            case "screenshot-refresh":
                return;
            default:
                throw HostFailure.Unsupported(tag);
        }
    }

    private static void SelectText(JsonElement action, ObservationRecord observation)
    {
        var element = ObservationElement(action, observation);
        var start = RequiredInteger(action, "start");
        var end = RequiredInteger(action, "end");
        if (start < 0 || end < start)
        {
            throw HostFailure.Malformed("selection");
        }

        if (!element.TryGetCurrentPattern(TextPattern.Pattern, out var rawPattern))
        {
            throw HostFailure.Unsupported("selection");
        }

        try
        {
            var pattern = (TextPattern)rawPattern;
            var range = pattern.DocumentRange.Clone();
            range.MoveEndpointByRange(
                TextPatternRangeEndpoint.End,
                range,
                TextPatternRangeEndpoint.Start
            );
            range.Move(TextUnit.Character, start);
            range.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, end - start);
            range.Select();
        }
        catch (ElementNotAvailableException)
        {
            throw HostFailure.Stale();
        }
    }

    private static void SetDirectValue(JsonElement action, ObservationRecord observation)
    {
        var element = ObservationElement(action, observation);
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var rawPattern))
        {
            throw HostFailure.Unsupported("direct-value");
        }

        try
        {
            ((ValuePattern)rawPattern).SetValue(RequiredString(action, "value"));
        }
        catch (ElementNotAvailableException)
        {
            throw HostFailure.Stale();
        }
    }

    private static void RunAccessibilityAction(
        JsonElement action,
        ObservationRecord observation
    )
    {
        var element = ObservationElement(action, observation);
        var name = RequiredString(action, "action").ToLowerInvariant();
        try
        {
            switch (name)
            {
                case "invoke":
                case "press":
                    ((InvokePattern)CurrentPattern(element, InvokePattern.Pattern, name)).Invoke();
                    return;
                case "select":
                    ((SelectionItemPattern)CurrentPattern(element, SelectionItemPattern.Pattern, name))
                        .Select();
                    return;
                case "toggle":
                    ((TogglePattern)CurrentPattern(element, TogglePattern.Pattern, name)).Toggle();
                    return;
                case "expand":
                    ((ExpandCollapsePattern)CurrentPattern(
                        element,
                        ExpandCollapsePattern.Pattern,
                        name
                    )).Expand();
                    return;
                case "collapse":
                    ((ExpandCollapsePattern)CurrentPattern(
                        element,
                        ExpandCollapsePattern.Pattern,
                        name
                    )).Collapse();
                    return;
                default:
                    throw HostFailure.Unsupported(name);
            }
        }
        catch (ElementNotAvailableException)
        {
            throw HostFailure.Stale();
        }
    }

    private static object CurrentPattern(
        AutomationElement element,
        AutomationPattern pattern,
        string operation
    )
    {
        if (!element.TryGetCurrentPattern(pattern, out var value))
        {
            throw HostFailure.Unsupported(operation);
        }

        return value;
    }

    private static AutomationElement ObservationElement(
        JsonElement action,
        ObservationRecord observation
    )
    {
        var elementId = RequiredString(action, "elementId");
        return observation.Elements.TryGetValue(elementId, out var element)
            ? element
            : throw HostFailure.Stale();
    }

    private static (JsonArray Encoded, Dictionary<string, AutomationElement> Indexed)
        ReadAccessibility(TargetRecord target)
    {
        var encoded = new JsonArray();
        var indexed = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);
        AutomationElement root;
        try
        {
            root = AutomationElement.FromHandle(target.Handle);
        }
        catch (ElementNotAvailableException)
        {
            return (encoded, indexed);
        }

        AutomationElementCollection elements;
        try
        {
            elements = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        }
        catch (ElementNotAvailableException)
        {
            return (encoded, indexed);
        }

        for (var index = 0; index < Math.Min(elements.Count, MaximumAccessibilityElements); index++)
        {
            var element = elements[index];
            try
            {
                var current = element.Current;
                var elementId = $"uia:{index}";
                var item = new JsonObject
                {
                    ["elementId"] = elementId,
                    ["role"] = string.IsNullOrWhiteSpace(current.LocalizedControlType)
                        ? "unknown"
                        : current.LocalizedControlType,
                    ["enabled"] = current.IsEnabled,
                };
                if (!string.IsNullOrWhiteSpace(current.Name))
                {
                    item["name"] = Truncate(current.Name);
                }

                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern))
                {
                    var value = ((ValuePattern)valuePattern).Current.Value;
                    if (!string.IsNullOrEmpty(value))
                    {
                        item["value"] = Truncate(value);
                    }
                }
                else if (element.TryGetCurrentPattern(TextPattern.Pattern, out var textPattern))
                {
                    var value = ((TextPattern)textPattern).DocumentRange.GetText(65_536);
                    if (!string.IsNullOrEmpty(value))
                    {
                        item["value"] = Truncate(value);
                    }
                }

                if (
                    element.TryGetCurrentPattern(
                        SelectionItemPattern.Pattern,
                        out var selectionPattern
                    )
                )
                {
                    item["selected"] = ((SelectionItemPattern)selectionPattern).Current.IsSelected;
                }

                var frame = current.BoundingRectangle;
                if (
                    !frame.IsEmpty
                    && double.IsFinite(frame.X)
                    && double.IsFinite(frame.Y)
                    && double.IsFinite(frame.Width)
                    && double.IsFinite(frame.Height)
                )
                {
                    var x = Math.Clamp((int)Math.Round(frame.X - target.Bounds.Left), 0, 65_535);
                    var y = Math.Clamp((int)Math.Round(frame.Y - target.Bounds.Top), 0, 65_535);
                    var width = Math.Clamp((int)Math.Round(frame.Width), 1, 65_535);
                    var height = Math.Clamp((int)Math.Round(frame.Height), 1, 65_535);
                    item["frame"] = new JsonObject
                    {
                        ["x"] = x,
                        ["y"] = y,
                        ["width"] = width,
                        ["height"] = height,
                    };
                }

                var actions = AccessibilityActions(element);
                if (actions.Count > 0)
                {
                    item["actions"] = actions;
                }

                encoded.Add(item);
                indexed[elementId] = element;
            }
            catch (ElementNotAvailableException)
            {
                // UI Automation trees can mutate during enumeration. A missing
                // element is omitted; the observation itself remains useful.
            }
        }

        return (encoded, indexed);
    }

    private static JsonArray AccessibilityActions(AutomationElement element)
    {
        var actions = new JsonArray();
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out _))
        {
            actions.Add("invoke");
        }

        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out _))
        {
            actions.Add("set-value");
        }

        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _))
        {
            actions.Add("select");
        }

        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out _))
        {
            actions.Add("toggle");
        }

        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out _))
        {
            actions.Add("expand");
            actions.Add("collapse");
        }

        if (element.TryGetCurrentPattern(TextPattern.Pattern, out _))
        {
            actions.Add("select-text");
        }

        return actions;
    }

    private static JsonObject? Capture(TargetRecord target)
    {
        if (!NativeMethods.IsWindow(target.Handle))
        {
            throw HostFailure.TargetClosed();
        }

        var size = HostMath.ScreenshotSize(target.Bounds.Width, target.Bounds.Height);
        var screenDc = NativeMethods.GetDC(IntPtr.Zero);
        if (screenDc == IntPtr.Zero)
        {
            throw HostFailure.Permission("screen-capture");
        }

        var memoryDc = NativeMethods.CreateCompatibleDC(screenDc);
        IntPtr bitmap = IntPtr.Zero;
        IntPtr previous = IntPtr.Zero;
        try
        {
            if (memoryDc == IntPtr.Zero)
            {
                throw HostFailure.Unsupported("screen-capture");
            }

            var information = BitmapInfo.Create(size.Width, size.Height);
            bitmap = NativeMethods.CreateDIBSection(
                screenDc,
                ref information,
                0,
                out var bits,
                IntPtr.Zero,
                0
            );
            if (bitmap == IntPtr.Zero || bits == IntPtr.Zero)
            {
                throw HostFailure.Unsupported("screen-capture");
            }

            previous = NativeMethods.SelectObject(memoryDc, bitmap);
            NativeMethods.SetStretchBltMode(memoryDc, 4);
            if (
                !NativeMethods.StretchBlt(
                    memoryDc,
                    0,
                    0,
                    size.Width,
                    size.Height,
                    screenDc,
                    target.Bounds.Left,
                    target.Bounds.Top,
                    target.Bounds.Width,
                    target.Bounds.Height,
                    0x00CC0020u | 0x40000000u
                )
            )
            {
                throw HostFailure.Permission("screen-capture");
            }

            var pixels = new byte[checked(size.Width * size.Height * 4)];
            Marshal.Copy(bits, pixels, 0, pixels.Length);
            var source = BitmapSource.Create(
                size.Width,
                size.Height,
                96,
                96,
                PixelFormats.Bgra32,
                null,
                pixels,
                size.Width * 4
            );
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(source));
            using var stream = new MemoryStream();
            encoder.Save(stream);
            return new JsonObject
            {
                ["mimeType"] = "image/png",
                ["base64"] = Convert.ToBase64String(stream.ToArray()),
                ["width"] = size.Width,
                ["height"] = size.Height,
            };
        }
        finally
        {
            if (previous != IntPtr.Zero && memoryDc != IntPtr.Zero)
            {
                NativeMethods.SelectObject(memoryDc, previous);
            }

            if (bitmap != IntPtr.Zero)
            {
                NativeMethods.DeleteObject(bitmap);
            }

            if (memoryDc != IntPtr.Zero)
            {
                NativeMethods.DeleteDC(memoryDc);
            }

            NativeMethods.ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    private void MoveCursor(NativePoint from, NativePoint to, int durationMs, string leaseId)
    {
        var points = HostMath.Interpolate(
            new Point(from.X, from.Y),
            new Point(to.X, to.Y),
            durationMs
        );
        var delay = durationMs > 0 ? Math.Max(1, durationMs / points.Count) : 0;
        for (var index = 0; index < points.Count; index++)
        {
            RequireActive(leaseId);
            SetCursor(new NativePoint(points[index].X, points[index].Y));
            if (delay > 0 && index + 1 < points.Count)
            {
                Thread.Sleep(delay);
            }
        }
    }

    private static void Focus(TargetRecord target)
    {
        NativeMethods.BringWindowToTop(target.Handle);
        NativeMethods.SetForegroundWindow(target.Handle);
        Thread.Sleep(40);
        if (NativeMethods.GetForegroundWindow() != target.Handle)
        {
            throw HostFailure.Unsupported("foreground-input");
        }
    }

    private void RequireActive(string leaseId)
    {
        if (DesktopIsLocked())
        {
            throw HostFailure.LockChanged();
        }

        if (_cancelledLeases.ContainsKey(leaseId))
        {
            throw HostFailure.Interrupted();
        }
    }

    private static TargetRecord RequireTarget(string targetId)
    {
        var target = DiscoverTargets().FirstOrDefault(target => target.TargetId == targetId);
        if (target is null)
        {
            throw HostFailure.TargetMissing();
        }

        if (TargetPolicy.IsForbidden(target.ExecutablePath, target.ProcessName))
        {
            throw HostFailure.PolicyDenied();
        }

        return target;
    }

    private static IReadOnlyList<TargetRecord> DiscoverTargets()
    {
        var targets = new List<TargetRecord>();
        NativeMethods.EnumWindows(
            (handle, _) =>
            {
                var target = TryCreateTarget(handle);
                if (target is not null)
                {
                    targets.Add(target);
                }

                return true;
            },
            IntPtr.Zero
        );
        return targets;
    }

    private static TargetRecord? TryCreateTarget(IntPtr handle)
    {
        if (
            !NativeMethods.IsWindowVisible(handle)
            || NativeMethods.IsIconic(handle)
            || !NativeMethods.GetWindowRect(handle, out var nativeBounds)
        )
        {
            return null;
        }

        var bounds = Rectangle.FromLTRB(
            nativeBounds.Left,
            nativeBounds.Top,
            nativeBounds.Right,
            nativeBounds.Bottom
        );
        if (bounds.Width < 32 || bounds.Height < 32)
        {
            return null;
        }

        var titleLength = NativeMethods.GetWindowTextLength(handle);
        if (titleLength <= 0)
        {
            return null;
        }

        var titleBuffer = new StringBuilder(titleLength + 1);
        if (NativeMethods.GetWindowText(handle, titleBuffer, titleBuffer.Capacity) <= 0)
        {
            return null;
        }

        NativeMethods.GetWindowThreadProcessId(handle, out var processId);
        var process = NativeMethods.OpenProcess(0x1000, false, processId);
        if (process == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            var pathLength = 32_768u;
            var pathBuffer = new StringBuilder((int)pathLength);
            if (!NativeMethods.QueryFullProcessImageName(process, 0, pathBuffer, ref pathLength))
            {
                return null;
            }

            var executablePath = pathBuffer.ToString();
            var processName = Path.GetFileName(executablePath);
            if (TargetPolicy.IsForbidden(executablePath, processName))
            {
                return null;
            }

            var appUserModelId = TryGetApplicationUserModelId(process);
            var applicationId = appUserModelId ?? executablePath;
            var stableIdentity = appUserModelId is not null
                ? $"windows:aumid:{appUserModelId}"
                : BuildExecutableIdentity(executablePath);
            var windowTitle = titleBuffer.ToString();
            var classification = TargetPolicy.Classify(executablePath, processName, windowTitle);
            return new TargetRecord(
                $"windows-window:{handle.ToInt64()}",
                $"{processName} — {windowTitle}",
                applicationId,
                stableIdentity,
                executablePath,
                processName,
                handle,
                bounds,
                classification
            );
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    private static string? TryGetApplicationUserModelId(IntPtr process)
    {
        var length = 0u;
        if (NativeMethods.GetApplicationUserModelId(process, ref length, null) != 122 || length == 0)
        {
            return null;
        }

        var value = new StringBuilder((int)length);
        return NativeMethods.GetApplicationUserModelId(process, ref length, value) == 0
            ? value.ToString()
            : null;
    }

    private static readonly ConcurrentDictionary<string, ExecutableIdentityCacheEntry>
        ExecutableIdentityCache = new(StringComparer.OrdinalIgnoreCase);

    private static string BuildExecutableIdentity(string path)
    {
        try
        {
            var information = new FileInfo(path);
            if (
                ExecutableIdentityCache.TryGetValue(path, out var cached)
                && cached.Length == information.Length
                && cached.LastWriteUtc == information.LastWriteTimeUtc
            )
            {
                return cached.Identity;
            }

            using var stream = File.OpenRead(path);
            var hash = Convert.ToHexString(SHA256.HashData(stream));
            var publisher = "unsigned";
            try
            {
#pragma warning disable SYSLIB0057 // Windows Authenticode extraction has no loader replacement.
                using var signedFile = X509Certificate.CreateFromSignedFile(path);
                using var certificate = new X509Certificate2(signedFile);
#pragma warning restore SYSLIB0057
                publisher = $"publisher:{certificate.Thumbprint}:{certificate.Subject}";
            }
            catch (CryptographicException)
            {
                // Unsigned applications remain path-and-hash bound.
            }

            var identity = $"windows:exe:{path.ToLowerInvariant()}:{publisher}:sha256:{hash}";
            ExecutableIdentityCache[path] = new ExecutableIdentityCacheEntry(
                information.Length,
                information.LastWriteTimeUtc,
                identity
            );
            if (ExecutableIdentityCache.Count > 512)
            {
                ExecutableIdentityCache.Clear();
            }

            return identity;
        }
        catch (IOException)
        {
            return $"windows:exe:{path.ToLowerInvariant()}:unreadable";
        }
        catch (UnauthorizedAccessException)
        {
            return $"windows:exe:{path.ToLowerInvariant()}:unreadable";
        }
    }

    private static NativePoint TargetPoint(JsonElement value, TargetRecord target)
    {
        var x = RequiredInteger(value, "x");
        var y = RequiredInteger(value, "y");
        if (x < 0 || y < 0 || x > target.Bounds.Width || y > target.Bounds.Height)
        {
            throw HostFailure.Stale();
        }

        return new NativePoint(target.Bounds.Left + x, target.Bounds.Top + y);
    }

    private static void SetCursor(NativePoint point)
    {
        if (!NativeMethods.SetCursorPos(point.X, point.Y))
        {
            throw HostFailure.Permission("input");
        }
    }

    private static void SendMouse(MouseEventFlags flags, uint data)
    {
        var input = NativeInput.Mouse(flags, data);
        if (NativeMethods.SendInput(1, [input], Marshal.SizeOf<NativeInput>()) != 1)
        {
            throw HostFailure.Permission("input");
        }
        InputTracker.TrackMouse(flags);
    }

    private static void SendKeyboard(params NativeInput[] inputs)
    {
        if (
            NativeMethods.SendInput(
                (uint)inputs.Length,
                inputs,
                Marshal.SizeOf<NativeInput>()
            ) != (uint)inputs.Length
        )
        {
            throw HostFailure.Permission("input");
        }
        foreach (var input in inputs)
        {
            if (input.Type == 1 && input.Value.Keyboard.VirtualKey != 0)
            {
                InputTracker.TrackKey(
                    input.Value.Keyboard.VirtualKey,
                    input.Value.Keyboard.Flags
                );
            }
        }
    }

    private static void TypeUnicode(string text)
    {
        foreach (var chunk in text.Chunk(64))
        {
            var inputs = new List<NativeInput>(chunk.Length * 2);
            foreach (var character in chunk)
            {
                inputs.Add(NativeInput.Keyboard(0, character, KeyboardEventFlags.Unicode));
                inputs.Add(
                    NativeInput.Keyboard(
                        0,
                        character,
                        KeyboardEventFlags.Unicode | KeyboardEventFlags.KeyUp
                    )
                );
            }
            SendKeyboard(inputs.ToArray());
        }
    }

    private static void Keypress(string key, IReadOnlyList<string> modifiers, string phase)
    {
        var mapping = KeyMapping.Resolve(key) ?? throw HostFailure.Unsupported($"keypress:{key}");
        var modifierKeys = mapping
            .ImpliedModifiers.Concat(modifiers.Select(KeyMapping.Modifier).Where(value => value != 0))
            .Distinct()
            .ToArray();
        var inputs = new List<NativeInput>();
        if (phase is "press" or "down")
        {
            inputs.AddRange(
                modifierKeys.Select(modifier =>
                    NativeInput.Keyboard(modifier, '\0', KeyboardEventFlags.None)
                )
            );
            inputs.Add(NativeInput.Keyboard(mapping.VirtualKey, '\0', KeyboardEventFlags.None));
        }

        if (phase is "press" or "up")
        {
            inputs.Add(NativeInput.Keyboard(mapping.VirtualKey, '\0', KeyboardEventFlags.KeyUp));
            inputs.AddRange(
                modifierKeys.Reverse().Select(modifier =>
                    NativeInput.Keyboard(modifier, '\0', KeyboardEventFlags.KeyUp)
                )
            );
        }

        if (inputs.Count == 0)
        {
            throw HostFailure.Malformed("keypress.phase");
        }

        SendKeyboard(inputs.ToArray());
    }

    private static void Paste(string text)
    {
        System.Windows.IDataObject? previous = null;
        try
        {
            previous = System.Windows.Clipboard.GetDataObject();
            System.Windows.Clipboard.SetText(text, System.Windows.TextDataFormat.UnicodeText);
            Keypress("v", ["control"], "press");
            Thread.Sleep(100);
        }
        catch (ExternalException error)
        {
            throw HostFailure.Unsupported($"clipboard:{error.ErrorCode}");
        }
        finally
        {
            try
            {
                if (previous is null)
                {
                    System.Windows.Clipboard.Clear();
                }
                else
                {
                    System.Windows.Clipboard.SetDataObject(previous, true);
                }
            }
            catch (ExternalException)
            {
                // Clipboard restoration is best-effort after Windows revokes access.
            }
        }
    }

    public static void ReleaseSyntheticInput()
    {
        var held = InputTracker.Release();
        try
        {
            if (held.LeftMouse) SendMouse(MouseEventFlags.LeftUp, 0);
            if (held.RightMouse) SendMouse(MouseEventFlags.RightUp, 0);
            if (held.Keys.Count > 0)
            {
                SendKeyboard(held.Keys.Select(KeyMapping.Release).ToArray());
            }
        }
        catch (HostFailure)
        {
            // Cleanup is attempted from every failure path and must not mask it.
        }
    }

    private static bool DesktopIsLocked()
    {
        var desktop = NativeMethods.OpenInputDesktop(0, false, 0x0001u | 0x0100u);
        if (desktop == IntPtr.Zero)
        {
            return true;
        }

        try
        {
            return !NativeMethods.SwitchDesktop(desktop);
        }
        finally
        {
            NativeMethods.CloseDesktop(desktop);
        }
    }

    private static string Truncate(string value) =>
        new(value.Take(65_536).ToArray());

    private static string RequiredString(JsonElement value, string property) =>
        value.TryGetProperty(property, out var result)
        && result.ValueKind == JsonValueKind.String
        && result.GetString() is { } text
            ? text
            : throw HostFailure.Malformed(property);

    private static string OptionalString(JsonElement value, string property, string fallback) =>
        value.TryGetProperty(property, out var result) && result.ValueKind == JsonValueKind.String
            ? result.GetString() ?? fallback
            : fallback;

    private static IReadOnlyList<string> OptionalStrings(JsonElement value, string property) =>
        value.TryGetProperty(property, out var result) && result.ValueKind == JsonValueKind.Array
            ? result
                .EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String)
                .Select(item => item.GetString() ?? string.Empty)
                .ToArray()
            : [];

    private static int RequiredInteger(JsonElement value, string property) =>
        value.TryGetProperty(property, out var result) && result.TryGetInt32(out var number)
            ? number
            : throw HostFailure.Malformed(property);

    private static int OptionalInteger(JsonElement value, string property, int fallback) =>
        value.TryGetProperty(property, out var result) && result.TryGetInt32(out var number)
            ? number
            : fallback;

    private static JsonElement RequiredObject(JsonElement value, string property) =>
        value.TryGetProperty(property, out var result) && result.ValueKind == JsonValueKind.Object
            ? result
            : throw HostFailure.Malformed(property);

    private static bool OptionalBoolean(JsonElement value, string property, bool fallback) =>
        value.TryGetProperty(property, out var result)
            ? result.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => fallback,
            }
            : fallback;

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        ReleaseSyntheticInput();
        _observations.Clear();
    }

    private sealed record ObservationRecord(
        TargetRecord Target,
        Dictionary<string, AutomationElement> Elements
    );

    private sealed record TargetRecord(
        string TargetId,
        string DisplayName,
        string ApplicationId,
        string StableIdentity,
        string ExecutablePath,
        string ProcessName,
        IntPtr Handle,
        Rectangle Bounds,
        TargetClassification Classification
    )
    {
        public JsonObject ToJson()
        {
            var integration = new JsonObject
            {
                ["_tag"] = Classification.Integration,
                ["supportedOperations"] = new JsonArray("observe", "act"),
            };
            if (Classification.Application is not null)
            {
                integration["application"] = Classification.Application;
            }
            if (Classification.DocumentName is not null)
            {
                integration["documentName"] = Classification.DocumentName;
            }
            return new JsonObject
            {
                ["targetId"] = TargetId,
                ["kind"] = Classification.Kind,
                ["displayName"] = DisplayName,
                ["applicationId"] = ApplicationId,
                ["stableIdentity"] = StableIdentity,
                ["integration"] = integration,
            };
        }
    }

    private sealed record ExecutableIdentityCacheEntry(
        long Length,
        DateTime LastWriteUtc,
        string Identity
    );
}

internal sealed class SyntheticInputTracker
{
    private readonly object _gate = new();
    private readonly HashSet<ushort> _keys = [];
    private bool _leftMouse;
    private bool _rightMouse;

    public void TrackMouse(MouseEventFlags flags)
    {
        lock (_gate)
        {
            if ((flags & MouseEventFlags.LeftDown) != 0) _leftMouse = true;
            if ((flags & MouseEventFlags.LeftUp) != 0) _leftMouse = false;
            if ((flags & MouseEventFlags.RightDown) != 0) _rightMouse = true;
            if ((flags & MouseEventFlags.RightUp) != 0) _rightMouse = false;
        }
    }

    public void TrackKey(ushort virtualKey, KeyboardEventFlags flags)
    {
        lock (_gate)
        {
            if ((flags & KeyboardEventFlags.KeyUp) == 0)
            {
                _keys.Add(virtualKey);
            }
            else
            {
                _keys.Remove(virtualKey);
            }
        }
    }

    public SyntheticInputSnapshot Release()
    {
        lock (_gate)
        {
            var snapshot = new SyntheticInputSnapshot(
                _leftMouse,
                _rightMouse,
                _keys.Order().ToArray()
            );
            _leftMouse = false;
            _rightMouse = false;
            _keys.Clear();
            return snapshot;
        }
    }
}

internal sealed record SyntheticInputSnapshot(
    bool LeftMouse,
    bool RightMouse,
    IReadOnlyList<ushort> Keys
);

internal sealed class HostFailure : Exception
{
    private HostFailure(HostErrorPayload payload)
        : base(payload.Message)
    {
        Payload = payload;
    }

    public HostErrorPayload Payload { get; }

    public static HostFailure Permission(string permission) =>
        new(
            HostErrorPayload.Create(
                "ComputerUsePermissionMissingError",
                "A required Windows capability is unavailable.",
                new JsonObject { ["permission"] = permission }
            )
        );

    public static HostFailure TargetMissing() =>
        new(
            HostErrorPayload.Create(
                "ComputerUseTargetNotFoundError",
                "The requested window is not available."
            )
        );

    public static HostFailure IdentityChanged() =>
        new(
            HostErrorPayload.Create(
                "ComputerUseTargetIdentityChangedError",
                "The requested application identity changed."
            )
        );

    public static HostFailure Stale() =>
        new(
            HostErrorPayload.Create(
                "ComputerUseStaleObservationError",
                "The observation is no longer current."
            )
        );

    public static HostFailure Unsupported(string operation) =>
        new(
            HostErrorPayload.Create(
                "ComputerUseUnsupportedOperationError",
                "The requested Computer Use operation is unsupported.",
                new JsonObject { ["operation"] = operation }
            )
        );

    public static HostFailure PolicyDenied() =>
        new(
            HostErrorPayload.Create(
                "ComputerUsePolicyDeniedError",
                "The helper denied this protected target."
            )
        );

    public static HostFailure TargetClosed() =>
        new(
            HostErrorPayload.Create(
                "ComputerUseTargetClosedError",
                "The target closed during the action."
            )
        );

    public static HostFailure LockChanged() =>
        new(
            HostErrorPayload.Create(
                "ComputerUseLockStateChangedError",
                "The Windows desktop locked or changed during Computer Use."
            )
        );

    public static HostFailure Interrupted() =>
        new(
            HostErrorPayload.Create(
                "ComputerUseInterruptedError",
                "The action was interrupted."
            )
        );

    public static HostFailure Malformed(string field) =>
        new(
            HostErrorPayload.Create(
                "ComputerUseMalformedResponseError",
                "The helper received a malformed request.",
                new JsonObject { ["field"] = field }
            )
        );
}

internal static class KeyMapping
{
    private static readonly Dictionary<string, ushort> NamedKeys = new(
        StringComparer.OrdinalIgnoreCase
    )
    {
        ["enter"] = 0x0D,
        ["return"] = 0x0D,
        ["tab"] = 0x09,
        ["space"] = 0x20,
        ["backspace"] = 0x08,
        ["delete"] = 0x2E,
        ["escape"] = 0x1B,
        ["esc"] = 0x1B,
        ["left"] = 0x25,
        ["arrowleft"] = 0x25,
        ["up"] = 0x26,
        ["arrowup"] = 0x26,
        ["right"] = 0x27,
        ["arrowright"] = 0x27,
        ["down"] = 0x28,
        ["arrowdown"] = 0x28,
        ["home"] = 0x24,
        ["end"] = 0x23,
        ["pageup"] = 0x21,
        ["pagedown"] = 0x22,
        ["insert"] = 0x2D,
        ["f1"] = 0x70,
        ["f2"] = 0x71,
        ["f3"] = 0x72,
        ["f4"] = 0x73,
        ["f5"] = 0x74,
        ["f6"] = 0x75,
        ["f7"] = 0x76,
        ["f8"] = 0x77,
        ["f9"] = 0x78,
        ["f10"] = 0x79,
        ["f11"] = 0x7A,
        ["f12"] = 0x7B,
    };

    public static ResolvedKey? Resolve(string key)
    {
        if (NamedKeys.TryGetValue(key, out var named))
        {
            return new ResolvedKey(named, []);
        }

        if (key.Length != 1)
        {
            return null;
        }

        var mapped = NativeMethods.VkKeyScan(key[0]);
        if (mapped == -1)
        {
            return null;
        }

        var modifiers = new List<ushort>();
        var flags = (mapped >> 8) & 0xff;
        if ((flags & 1) != 0)
        {
            modifiers.Add(0xA0);
        }

        if ((flags & 2) != 0)
        {
            modifiers.Add(0xA2);
        }

        if ((flags & 4) != 0)
        {
            modifiers.Add(0xA4);
        }

        return new ResolvedKey((ushort)(mapped & 0xff), modifiers);
    }

    public static ushort Modifier(string modifier) =>
        modifier.ToLowerInvariant() switch
        {
            "shift" => 0xA0,
            "control" => 0xA2,
            "alt" => 0xA4,
            "meta" => 0x5B,
            _ => 0,
        };

    public static NativeInput Release(ushort virtualKey) =>
        NativeInput.Keyboard(virtualKey, '\0', KeyboardEventFlags.KeyUp);

    public sealed record ResolvedKey(ushort VirtualKey, IReadOnlyList<ushort> ImpliedModifiers);
}

[Flags]
internal enum MouseEventFlags : uint
{
    LeftDown = 0x0002,
    LeftUp = 0x0004,
    RightDown = 0x0008,
    RightUp = 0x0010,
    Wheel = 0x0800,
    HorizontalWheel = 0x1000,
}

[Flags]
internal enum KeyboardEventFlags : uint
{
    None = 0,
    KeyUp = 0x0002,
    Unicode = 0x0004,
}

[StructLayout(LayoutKind.Sequential)]
internal readonly record struct NativePoint(int X, int Y);

[StructLayout(LayoutKind.Sequential)]
internal struct NativeRectangle
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BitmapInfoHeader
{
    public uint Size;
    public int Width;
    public int Height;
    public ushort Planes;
    public ushort BitCount;
    public uint Compression;
    public uint SizeImage;
    public int XPelsPerMeter;
    public int YPelsPerMeter;
    public uint ColorsUsed;
    public uint ColorsImportant;
}

[StructLayout(LayoutKind.Sequential)]
internal struct RgbQuad
{
    public byte Blue;
    public byte Green;
    public byte Red;
    public byte Reserved;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BitmapInfo
{
    public BitmapInfoHeader Header;
    public RgbQuad Colors;

    public static BitmapInfo Create(int width, int height) =>
        new()
        {
            Header = new BitmapInfoHeader
            {
                Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(),
                Width = width,
                Height = -height,
                Planes = 1,
                BitCount = 32,
                Compression = 0,
                SizeImage = checked((uint)(width * height * 4)),
            },
        };
}

[StructLayout(LayoutKind.Sequential)]
internal struct MouseInput
{
    public int X;
    public int Y;
    public uint MouseData;
    public MouseEventFlags Flags;
    public uint Time;
    public UIntPtr ExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
internal struct KeyboardInput
{
    public ushort VirtualKey;
    public ushort ScanCode;
    public KeyboardEventFlags Flags;
    public uint Time;
    public UIntPtr ExtraInfo;
}

[StructLayout(LayoutKind.Explicit)]
internal struct InputUnion
{
    [FieldOffset(0)]
    public MouseInput Mouse;

    [FieldOffset(0)]
    public KeyboardInput Keyboard;
}

[StructLayout(LayoutKind.Sequential)]
internal struct NativeInput
{
    public uint Type;
    public InputUnion Value;

    public static NativeInput Mouse(MouseEventFlags flags, uint data) =>
        new()
        {
            Type = 0,
            Value = new InputUnion
            {
                Mouse = new MouseInput { MouseData = data, Flags = flags },
            },
        };

    public static NativeInput Keyboard(
        ushort virtualKey,
        char scanCode,
        KeyboardEventFlags flags
    ) =>
        new()
        {
            Type = 1,
            Value = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    VirtualKey = virtualKey,
                    ScanCode = scanCode,
                    Flags = flags,
                },
            },
        };
}

internal static class NativeMethods
{
    internal delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsIconic(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindow(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetWindowRect(IntPtr handle, out NativeRectangle rectangle);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW")]
    internal static extern int GetWindowTextLength(IntPtr handle);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximumCount);

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", EntryPoint = "GetApplicationUserModelId", CharSet = CharSet.Unicode)]
    internal static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder? value);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool BringWindowToTop(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetCursorPos(out NativePoint point);

    [DllImport("user32.dll")]
    internal static extern uint SendInput(uint count, [In] NativeInput[] inputs, int size);

    [DllImport("user32.dll", EntryPoint = "VkKeyScanW", CharSet = CharSet.Unicode)]
    internal static extern short VkKeyScan(char character);

    [DllImport("user32.dll")]
    internal static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SwitchDesktop(IntPtr desktop);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetDC(IntPtr handle);

    [DllImport("user32.dll")]
    internal static extern int ReleaseDC(IntPtr handle, IntPtr deviceContext);

    [DllImport("gdi32.dll")]
    internal static extern IntPtr CreateCompatibleDC(IntPtr deviceContext);

    [DllImport("gdi32.dll")]
    internal static extern IntPtr CreateDIBSection(IntPtr deviceContext, ref BitmapInfo information, uint usage, out IntPtr bits, IntPtr section, uint offset);

    [DllImport("gdi32.dll")]
    internal static extern IntPtr SelectObject(IntPtr deviceContext, IntPtr value);

    [DllImport("gdi32.dll")]
    internal static extern int SetStretchBltMode(IntPtr deviceContext, int mode);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool StretchBlt(IntPtr destination, int destinationX, int destinationY, int destinationWidth, int destinationHeight, IntPtr source, int sourceX, int sourceY, int sourceWidth, int sourceHeight, uint operation);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DeleteObject(IntPtr value);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DeleteDC(IntPtr deviceContext);
}
