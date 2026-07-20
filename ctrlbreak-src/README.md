# ctrlbreak.exe

Tiny native helper that sends a real Windows console `CTRL_BREAK_EVENT` to a
process by PID, so `sing-box.exe` can run its graceful-shutdown path (which
releases the WinTun adapter cleanly) instead of being hard-killed.

## Why this exists

Node's `child.kill('SIGTERM')` on Windows is not a real signal — libuv maps
it straight to `TerminateProcess()`, giving the target zero chance to run
its own cleanup. sing-box's shutdown handler is what calls
`WintunCloseAdapter()`; skipping it corrupts the adapter for the next start
(`create adapter: file already exists` / `open existing adapter: Element not
found`).

An earlier version of this helper used PowerShell's `Add-Type` to compile the
same C# inline at runtime. That works, but `Add-Type` invokes `csc.exe`
fresh on every call — measured at 3.4-5.4+ seconds in practice, which
occasionally exceeded the timeout and silently fell back to a hard kill,
re-corrupting the adapter. The precompiled `.exe` runs in ~200ms.

## Important: the helper's own exit status is unreliable — and that's OK

`GenerateConsoleCtrlEvent` can only reliably reach sing-box by broadcasting
to process group `0` (every process attached to sing-box's console). sing-box
was NOT spawned with `CREATE_NEW_PROCESS_GROUP` (that flag only gets set by
Node/libuv when using `detached: true`, which also strips the console
entirely — a conflict that rules out targeting sing-box's own PID as a
process-group ID instead). That means this helper's own process is *also* on
the receiving end of that same broadcast, and its default CTRL_BREAK action
is to terminate — which happens reliably enough that this helper often dies
before it can print a result, even with `SetConsoleCtrlHandler` registered.

This is expected and harmless. The caller (`electron/main.ts`) does **not**
await or branch on this helper's exit code/output — it just fires it and then
relies on sing-box's own `exit` event (with a timeout fallback) to know
whether the graceful shutdown actually worked. An earlier version *did* treat
a "failed" helper result as a signal to immediately hard-kill sing-box, which
fired a redundant `SIGTERM` on top of the already-in-progress graceful
shutdown and was itself the thing corrupting the WinTun adapter.

## Rebuilding

Requires the .NET Framework C# compiler (ships with Windows):

```
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /platform:x64 /out:..\resources\bin\ctrlbreak.exe CtrlBreak.cs
```

Only needs to be rebuilt if `CtrlBreak.cs` changes — the compiled
`resources/bin/ctrlbreak.exe` is committed/bundled like `sing-box.exe`.
