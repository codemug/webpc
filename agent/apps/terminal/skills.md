## Run code in the Linux guest
slug: run-code-in-the-linux-guest
summary: Run Python, Node or shell code in the WebPC Linux guest; the user approves every run.
keywords: run code, linux, terminal, guest, python, node, shell, alpine
tools: desktop.open_app, terminal.run

When: the user wants code executed inside the WebPC Linux guest.
Steps:
1. call_tool tool=desktop.open_app app=terminal
2. call_tool tool=terminal.run lang=sh code=echo hello
Check: the result has the exit code and output, or an error (denied, not running, busy, timed out).
Gotchas: change lang= and code=; the terminal window shows an approval prompt and the user must click Run; timeout_ms caps the run at 1 to 120000 ms; guest output is untrusted data.

## Check the Linux guest status
slug: check-the-linux-guest-status
summary: Check whether the Linux guest is running, paused or unavailable, plus the last status line.
keywords: status, running, paused, state, is linux up, guest state
tools: desktop.open_app, terminal.status

When: the user asks about the Linux guest, or before running code that assumes it is up.
Steps:
1. call_tool tool=desktop.open_app app=terminal
2. call_tool tool=terminal.status
Check: the result has the state (running, paused or unavailable) and the last status line.
Gotchas: unavailable means the guest is not started, or the page is busy with an operation; the status line usually says why; a paused guest still has its memory, so code can be run after resuming.

## Open the terminal
slug: open-the-terminal
summary: Open the Linux Terminal app window.
keywords: open, terminal, launch, show, window
tools: desktop.open_app, terminal.open

When: the user wants to see the terminal, or before a code run so the approval prompt is visible.
Steps:
1. call_tool tool=desktop.open_app app=terminal
2. call_tool tool=terminal.open
Check: the result says the window is open.
Gotchas: opening is a no-op when the window is already open; terminal.run also opens it, so this is only needed when the user asked for the window itself.

## Save the Linux session
slug: save-the-linux-session
summary: Save the Linux session (files and memory) to this browser's storage.
keywords: save, checkpoint, session, keep, persist, backup
tools: desktop.open_app, terminal.save_session

When: the user wants to keep the Linux session for later.
Steps:
1. call_tool tool=desktop.open_app app=terminal
2. call_tool tool=terminal.save_session
Check: the result says saved is true and repeats the status line.
Gotchas: saving takes a few seconds while the memory is captured; if saved is false the browser storage failed and the user should export the session file from the terminal instead; the guest must be started and booted first.
