## Open an app
slug: launch-an-app
summary: Start an app on the desktop and confirm it opened.
keywords: open, launch, start, run, boot
tools: desktop.open_app

When: the user names an app to start, or asks to launch something.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
Check: desktop.list_windows shows gridcraft as open and active.
Gotchas: change app= to the id from desktop.list_apps; an unknown id is rejected with the closest match.

## Close an app
slug: close-a-window
summary: Close an app window, and force close only if it has unsaved work and the user agrees.
keywords: close, quit, exit, shut down, stop
tools: desktop.close, desktop.force_close

When: the user asks to quit or close an app; the app may have unsaved work.
Steps:
1. call_tool tool=desktop.close app=gridcraft
2. call_tool tool=desktop.force_close app=gridcraft
Check: desktop.list_windows no longer lists gridcraft.
Gotchas: step 2 only when step 1 returns closed: false and dirty: true, and only after asking the user; a force close loses unsaved work.

## Switch to an app
slug: switch-to-an-app
summary: Bring an open app window to the front of the desktop.
keywords: switch, focus, bring to front, select, show
tools: desktop.focus

When: the user wants to switch to, select or show an app that is already open.
Steps:
1. call_tool tool=desktop.focus app=docs
Check: desktop.list_windows shows docs as active.
Gotchas: the app must be open; open it first with desktop.open_app. change app= to the app id.

## Minimize and bring back
slug: hide-and-bring-back
summary: Hide an app window to the taskbar, then bring it back.
keywords: minimize, hide, unminimize, restore, bring back
tools: desktop.minimize, desktop.restore

When: the user wants to tuck a window away and later continue in it.
Steps:
1. call_tool tool=desktop.minimize app=files
2. call_tool tool=desktop.restore app=files
Check: after step 1 the window is state minimized; after step 2 it is state normal again.
Gotchas: change app= to the app id; a window that is not open is rejected with not_open.

## Maximize a window
slug: maximize-a-window
summary: Make an app window fill the desktop, and bring it back to its size.
keywords: maximize, expand, full screen, fill, enlarge
tools: desktop.maximize, desktop.restore

When: the user wants an app to take the whole desktop, or back to its old size.
Steps:
1. call_tool tool=desktop.maximize app=gridcraft
2. call_tool tool=desktop.restore app=gridcraft
Check: after step 1 the window is state maximized and fills the desktop; after step 2 it is state normal.
Gotchas: step 2 returns the window to its previous size; change app= to the app id.

## Move a window
slug: move-a-window
summary: Move an app window to a pixel position on the desktop.
keywords: move, drag, reposition, shift, place
tools: desktop.move

When: the user wants a window at a particular spot on the desktop.
Steps:
1. call_tool tool=desktop.move app=terminal x=40 y=60
Check: desktop.list_windows shows the window at x 40 and y 60.
Gotchas: change app=, x and y; the values are pixels from the desktop top-left corner and are clamped inside the desktop.

## Resize a window
slug: resize-a-window
summary: Set an app window to a given width and height in pixels.
keywords: resize, enlarge, shrink, stretch, size
tools: desktop.resize

When: the user wants a window bigger or smaller, or a certain size.
Steps:
1. call_tool tool=desktop.resize app=docs width=800 height=500
Check: desktop.list_windows shows the window at width 800 and height 500.
Gotchas: change app=, width and height; width is at least 200 and height at least 150, and both are clamped to the desktop.

## Put windows side by side
slug: side-by-side
summary: Arrange all visible windows in halves, a grid or a cascade.
keywords: side by side, split screen, arrange, tile, next to each other
tools: desktop.tile

When: the user wants several windows next to each other or neatly arranged.
Steps:
1. call_tool tool=desktop.tile layout=left-right
Check: desktop.list_windows shows the windows in two halves of the desktop.
Gotchas: change layout= to grid or cascade; minimized and maximized windows are skipped.

## Show the desktop
slug: show-the-desktop
summary: Minimize every window so the desktop is clear.
keywords: show desktop, clear screen, minimize all, clean screen, unclutter
tools: desktop.show_desktop

When: the user wants a clear screen or the desktop with no windows in front.
Steps:
1. call_tool tool=desktop.show_desktop
Check: desktop.list_windows shows every window as minimized.
Gotchas: nothing is closed; open any window again with desktop.open_app.

## Light or dark mode
slug: make-it-dark
summary: Switch the desktop between light and dark color themes.
keywords: dark mode, light mode, theme, color, toggle
tools: desktop.get_theme, desktop.set_theme

When: the user asks for dark mode, light mode, or which theme is on.
Steps:
1. call_tool tool=desktop.get_theme
2. call_tool tool=desktop.set_theme theme=dark
Check: desktop.get_theme returns dark after step 2.
Gotchas: change theme= to light or dark; step 1 is optional when the target theme is known.

## Tidy the desktop icons
slug: tidy-the-icons
summary: Put the desktop icons back on the default grid layout.
keywords: tidy icons, arrange icons, clean up, organize, sort icons
tools: desktop.arrange_icons

When: the icons were moved around and the user wants the desktop tidied.
Steps:
1. call_tool tool=desktop.arrange_icons
Check: the desktop icons sit back on the default grid.
Gotchas: saved custom positions are cleared; this is the same as the desktop menu Arrange icons.

## See what is open
slug: see-what-is-open
summary: List every open window with its state, activity and position.
keywords: what is open, open apps, windows, running, list
tools: desktop.list_windows

When: the user asks what is open, or before closing, moving or arranging windows.
Steps:
1. call_tool tool=desktop.list_windows
Check: the result lists id, title, state, active and the position of every open window.
Gotchas: the top of the list is the front window; minimized windows are listed too.

## Close everything
slug: close-everything
summary: Close every open app window, asking about any with unsaved work.
keywords: close all, quit everything, close everything, end all, clear all
tools: desktop.list_windows, desktop.close

When: the user wants to quit all apps at once.
Steps:
1. call_tool tool=desktop.list_windows
2. call_tool tool=desktop.close app=docs
3. call_tool tool=desktop.close app=files
Check: desktop.list_windows returns no windows.
Gotchas: repeat step 2 with each app id from step 1; if a close returns dirty: true, ask the user and use desktop.force_close before continuing.

## Open an app in a new tab or window
slug: open-in-a-new-tab
summary: Open an app in a new browser tab or a separate browser window.
keywords: new tab, new window, open separately, detach, popup
tools: desktop.open_in_tab

When: the user wants an app outside the desktop, in its own tab or window.
Steps:
1. call_tool tool=desktop.open_in_tab app=files how=tab
Check: the app loads in a new browser tab and the desktop is unchanged.
Gotchas: change app= and how= (tab or window); the desktop window of the app, if open, stays open.

## Find an app by what it does
slug: find-the-right-app
summary: List the apps of a category to find the right one.
keywords: find app, search apps, which app, look for, category
tools: desktop.list_apps

When: the user describes a job (spreadsheet, documents, files) and needs the app for it.
Steps:
1. call_tool tool=desktop.list_apps category=Office
Check: the result lists the apps of the Office category with their descriptions.
Gotchas: change category= to a category from desktop.list_apps; without a category the tool lists every app.
