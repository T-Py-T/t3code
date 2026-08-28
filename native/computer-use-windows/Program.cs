using System.Collections.Concurrent;
using System.Text.Json;

namespace T3Code.ComputerUse.Windows;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    [STAThread]
    public static int Main()
    {
        var requests = new BlockingCollection<HostRequest>(64);
        var cancelledLeases = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        Exception? workerFailure = null;
        var worker = new Thread(() =>
        {
            try
            {
                using var host = new WindowsComputerUseHost(cancelledLeases);
                foreach (var request in requests.GetConsumingEnumerable())
                {
                    var response = host.Handle(request);
                    Console.Out.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
                    Console.Out.Flush();
                }
            }
            catch (Exception error)
            {
                workerFailure = error;
            }
        })
        {
            IsBackground = false,
            Name = "T3 Code Computer Use",
        };
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();

        string? line;
        while ((line = Console.In.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            if (!HostCommandParser.TryParse(line, out var request, out var cancellation))
            {
                Console.Error.WriteLine("Invalid Computer Use command.");
                continue;
            }

            if (request is not null)
            {
                if (!requests.TryAdd(request, request.TimeoutMs))
                {
                    Console.Error.WriteLine("Computer Use request queue is unavailable.");
                }
            }
            else if (cancellation is { } cancel)
            {
                cancelledLeases.TryAdd(cancel.LeaseId, 0);
                WindowsComputerUseHost.ReleaseSyntheticInput();
            }
        }

        requests.CompleteAdding();
        worker.Join();
        if (workerFailure is not null)
        {
            Console.Error.WriteLine($"Windows Computer Use host failed: {workerFailure.Message}");
            return 1;
        }

        return 0;
    }
}
