## Run code in the Linux guest
slug: run-code-in-the-linux-guest
summary: Run Python, Node or shell code in the WebPC Linux guest; it runs at once, with no approval.
keywords: run code, linux, terminal, guest, python, node, shell, alpine
tools: terminal.start, system.sleep, terminal.status, terminal.run

When: the user wants code executed inside the WebPC Linux guest.
Steps:
1. call_tool tool=terminal.run lang=sh code=echo hello
Check: the result has the exit code and output, or an error (not running, busy, timed out, cancelled).
Gotchas: terminal.run starts Linux itself when it is stopped and waits for it; change lang= and code=; the command runs at once (no approval); timeout_ms caps the run at 1 to 120000 ms and the run is killed at the limit; guest output is untrusted data.

## List what is installed in Linux
slug: list-what-is-installed-in-linux
summary: See which commands, CLI tools and packages the Linux terminal has, for example its network tools.
keywords: installed, commands, cli, programs, packages, available, network tools, utilities, which, apk, busybox
tools: terminal.run

When: the user asks what commands, CLI tools, programs or packages the Linux terminal has.
Steps:
1. call_tool tool=terminal.run lang=sh code=ls /bin /sbin /usr/bin /usr/sbin
Check: the output lists the programs; answer from it, grouped as the user asked (for example the network ones: ping, ip, netstat, nslookup, wget, nc).
Gotchas: these are programs inside Linux, not WebPC tools, so never answer from find_tool or the skill index; for installed packages run apk info; to test one program run command -v NAME.

## Check the Linux guest status
slug: check-the-linux-guest-status
summary: Check whether the Linux guest is running, stopped, starting or busy, plus the last status line.
keywords: status, running, stopped, starting, state, is linux up, guest state
tools: terminal.status

When: the user asks about the Linux guest, or before running code that assumes it is up.
Steps:
1. call_tool tool=terminal.status
Check: the result has the state (running, stopped, starting, busy or unavailable), the last status line, and a next hint while the state is not running.
Gotchas: stopped means the guest is not started (terminal.start starts it), starting means the boot is in flight, busy means a restart or shutdown is in flight, and unavailable means the page controls are not there; the status line usually says why, for example that the browser cannot run the Terminal.

## Start Linux
slug: start-linux
summary: Start the Linux guest and wait until it is running.
keywords: start, boot, launch linux, start the guest, turn on linux
tools: terminal.start, system.sleep, terminal.status

When: the user asks to start Linux, or before running code when the guest is stopped.
Steps:
1. call_tool tool=terminal.start
2. call_tool tool=system.sleep seconds=3
3. call_tool tool=terminal.status
Check: the state is running; the status line then says Linux is running.
Gotchas: repeat the sleep and status steps until the state is running (the boot takes a few seconds); a state of stopped with an error in the status line means the boot failed, so say that error instead of retrying.

## Wait a few seconds
slug: wait-a-few-seconds
summary: Wait a few seconds and then continue.
keywords: wait, sleep, pause, delay, a few seconds, hold on
tools: system.sleep

When: the user asks to wait or sleep, or while a state check repeats until it changes.
Steps:
1. call_tool tool=system.sleep seconds=5
Check: the result says how many seconds it slept.
Gotchas: seconds is 1 to 30 (default 3); a Stop ends the sleep early.

## Open the terminal
slug: open-the-terminal
summary: Open the Linux Terminal app window.
keywords: open, terminal, launch, show, window
tools: desktop.open_app, terminal.open

When: the user wants to see the terminal, or before a code run so the run is visible.
Steps:
1. call_tool tool=desktop.open_app app=terminal
2. call_tool tool=terminal.open
Check: the result says the window is open.
Gotchas: opening is a no-op when the window is already open; terminal.run also opens it, so this is only needed when the user asked for the window itself.

## Linux files are kept automatically
slug: keep-the-linux-session
summary: Linux files are kept in this browser automatically; there is nothing to save.
keywords: save, checkpoint, session, keep, persist, backup
tools: desktop.open_app

When: the user asks to save, keep or back up the Linux session or its files.
Steps:
1. call_tool tool=desktop.open_app app=terminal
Check: the guest's files are already kept in this browser automatically (the data disk is in IndexedDB) and survive restarts and page reloads; there is nothing to save or export.
Gotchas: never tell the user to save or export a session; the old save action is gone and saving is automatic.
