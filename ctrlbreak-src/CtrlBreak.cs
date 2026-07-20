using System;
using System.Runtime.InteropServices;

// Minimal helper: send a real Windows console CTRL_BREAK_EVENT to a target
// process by PID. Compiled once at build time so the app never needs to pay
// a live C# compile (Add-Type/csc.exe) cost on every disconnect -- that cost
// was measured at 3-5+ seconds and occasionally exceeded our timeout,
// silently falling back to a hard TerminateProcess kill and corrupting the
// WinTun adapter (SagerNet/sing-box#3806).
public class CtrlBreak
{
    delegate bool ConsoleCtrlDelegate(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate HandlerRoutine, bool Add);

    public static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: ctrlbreak.exe <pid>");
            return 2;
        }

        uint pid;
        if (!uint.TryParse(args[0], out pid))
        {
            Console.Error.WriteLine("invalid pid");
            return 2;
        }

        // NOTE: sing-box's console was NOT created with CREATE_NEW_PROCESS_GROUP
        // (that flag is only set by Node/libuv when spawning with
        // `detached: true`, which ALSO strips the console entirely -- a
        // conflict that makes a per-PID process-group target unusable here).
        // Without that flag, sing-box is not a process-group leader, so
        // targeting its own PID as the group ID fails outright
        // (GenerateConsoleCtrlEvent returns false / ERROR_INVALID_PARAMETER).
        // The only group ID that reaches it is 0 (broadcast to everyone on
        // the console) -- confirmed empirically to make sing-box exit
        // gracefully every time. The catch: that broadcast also hits THIS
        // helper once it attaches, and CTRL_BREAK's default termination
        // cannot be reliably suppressed here (measured: still died with
        // STATUS_CONTROL_C_EXIT despite a registered handler). So this
        // process may die immediately after sending -- that's fine and
        // expected; the caller (Node) does NOT trust this helper's own exit
        // status/output as proof of success. It only fires the break and
        // then watches sing-box's OWN process-exit event with a real grace
        // period, which is the reliable signal.
        FreeConsole();
        if (!AttachConsole(pid))
        {
            Console.WriteLine("ATTACH_FAILED");
            return 1;
        }

        GenerateConsoleCtrlEvent(1 /* CTRL_BREAK_EVENT */, 0);
        // No sleep/FreeConsole after this point: the broadcast likely already
        // terminated this process by the time GenerateConsoleCtrlEvent
        // returns. Anything below is best-effort only.
        Console.WriteLine("SENT");
        return 0;
    }
}
