using System.Drawing;
using System.Text.Json;
using T3Code.ComputerUse.Windows;

var tests = new (string Name, Action Run)[]
{
    ("request round trip", RequestRoundTrip),
    ("cancellation round trip", CancellationRoundTrip),
    ("bounded host error", BoundedHostError),
    ("protected targets", ProtectedTargets),
    ("bounded screenshot dimensions", BoundedScreenshotDimensions),
    ("pointer interpolation", PointerInterpolation),
    ("synthetic input release tracking", SyntheticInputReleaseTracking),
};
var failures = 0;
foreach (var (name, run) in tests)
{
    try
    {
        run();
        Console.WriteLine($"PASS {name}");
    }
    catch (Exception error)
    {
        failures++;
        Console.Error.WriteLine($"FAIL {name}: {error.Message}");
    }
}

Console.WriteLine($"{tests.Length - failures}/{tests.Length} Windows Computer Use tests passed.");
return failures == 0 ? 0 : 1;

static void RequestRoundTrip()
{
    const string line = """
        {"type":"request","request":{"requestId":"request-1","leaseId":"lease-1","environmentId":"environment-1","operation":"act","targetId":"target-1","observationId":"observation-1","input":{"actions":[{"_tag":"click","x":10,"y":20}]},"timeoutMs":15000}}
        """;
    Assert(HostCommandParser.TryParse(line, out var request, out var cancellation));
    Assert(request is not null && cancellation is null);
    var parsedRequest = request!;
    Assert(parsedRequest.RequestId == "request-1" && parsedRequest.Operation == "act");
    var response = HostResponse.Success(
        parsedRequest,
        JsonSerializer.SerializeToNode(new { ok = true })!
    );
    var encoded = JsonSerializer.Serialize(response);
    Assert(encoded.Contains("\"requestId\":\"request-1\"", StringComparison.Ordinal));
    Assert(!encoded.Contains("\"error\"", StringComparison.Ordinal));
}

static void CancellationRoundTrip()
{
    const string line = """{"type":"cancel","leaseId":"lease-1","reason":"takeover"}""";
    Assert(HostCommandParser.TryParse(line, out var request, out var cancellation));
    Assert(request is null && cancellation is { LeaseId: "lease-1", Reason: "takeover" });
}

static void BoundedHostError()
{
    var error = HostErrorPayload.Create(
        "ComputerUseInterruptedError",
        new string('x', 5_000)
    );
    Assert(error.Message.Length == HostErrorPayload.MaximumMessageLength);
}

static void ProtectedTargets()
{
    Assert(TargetPolicy.IsForbidden(@"C:\Windows\System32\cmd.exe", "Command Prompt"));
    Assert(TargetPolicy.IsForbidden(@"C:\Program Files\PowerShell\7\pwsh.exe", "PowerShell"));
    Assert(TargetPolicy.IsForbidden(@"C:\Program Files\T3 Code\T3Code.exe", "T3 Code"));
    Assert(!TargetPolicy.IsForbidden(@"C:\Windows\System32\notepad.exe", "Notepad"));
}

static void BoundedScreenshotDimensions()
{
    Assert(HostMath.ScreenshotSize(1_024, 768) == new Size(1_024, 768));
    var large = HostMath.ScreenshotSize(7_680, 4_320);
    Assert(large.Width <= 2_048 && large.Height <= 2_048);
    Assert((long)large.Width * large.Height <= 2_000_000);
}

static void PointerInterpolation()
{
    var immediate = HostMath.Interpolate(new Point(0, 0), new Point(10, 20), 0);
    Assert(immediate.Count == 1 && immediate[0] == new Point(10, 20));
    var smooth = HostMath.Interpolate(new Point(0, 0), new Point(160, 320), 160);
    Assert(smooth.Count == 10);
    Assert(smooth[^1] == new Point(160, 320));
}

static void SyntheticInputReleaseTracking()
{
    var tracker = new SyntheticInputTracker();
    tracker.TrackMouse(MouseEventFlags.LeftDown);
    tracker.TrackMouse(MouseEventFlags.LeftUp);
    tracker.TrackKey(0xA2, KeyboardEventFlags.None);
    tracker.TrackKey(0xA2, KeyboardEventFlags.KeyUp);
    var completed = tracker.Release();
    Assert(!completed.LeftMouse && !completed.RightMouse && completed.Keys.Count == 0);

    tracker.TrackMouse(MouseEventFlags.RightDown);
    tracker.TrackKey(0xA0, KeyboardEventFlags.None);
    var interrupted = tracker.Release();
    Assert(interrupted.RightMouse && !interrupted.LeftMouse);
    Assert(interrupted.Keys.Count == 1 && interrupted.Keys[0] == 0xA0);
    Assert(tracker.Release().Keys.Count == 0);
}

static void Assert(bool condition)
{
    if (!condition)
    {
        throw new InvalidOperationException("Assertion failed.");
    }
}
