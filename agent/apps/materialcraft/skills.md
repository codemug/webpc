## Open a package or bitmap from Files
slug: open-a-package-from-files
summary: Open a .sbs or .mcraft package, or drop in a bitmap, that is stored in Files in MaterialCraft.
keywords: open, load, from files, sbs, mcraft, bitmap, image, shader
tools: desktop.open_app, materialcraft.open_file

When: the user wants to open a MaterialCraft package or add a bitmap that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=materialcraft
2. call_tool tool=materialcraft.open_file path=/MaterialCraft/wood.sbs
Check: materialcraft.status shows the wrapper opened the file; the package or bitmap appears in the editor.
Gotchas: change path= to a .sbs or .mcraft package or an image to use as a bitmap; a new WebPC session starts with an empty graph; if the open package reports unsaved changes the wrapper asks first before opening the new file.

## Save a copy of the package to Files
slug: save-a-package-copy-to-files
summary: Save a copy of the MaterialCraft package to Files as the editor produces it.
keywords: save, copy, to files, sbs, mcraft, export, keep, write
tools: desktop.open_app, materialcraft.save_copy

When: the user wants to keep a copy of the MaterialCraft package in Files.
Steps:
1. call_tool tool=desktop.open_app app=materialcraft
2. call_tool tool=materialcraft.save_copy path=/MaterialCraft/wood.sbs
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: the tool waits for the user to save in the editor; the package saves as .sbs, .mcraft or a _sbs.zip web transport, so match the target to what the editor produces (a mismatch is refused with the produced extension as the fix); if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive).

## Build shader graphs in the editor
slug: build-shader-graphs-in-the-editor
summary: MaterialCraft builds shader graphs for game engines in its native editor; the agent opens the app and the user works the editor.
keywords: shader, graph, material, sbs, node, texture, game engine, build
tools: desktop.open_app, materialcraft.status

When: the user wants to build or edit a shader graph in MaterialCraft.
Steps:
1. call_tool tool=desktop.open_app app=materialcraft
Check: the editor is open and showing the graph; the user drives the native node editor directly.
Gotchas: the agent has no MaterialCraft editing tools, so it opens the app and the user works the editor; materialcraft.status shows the wrapper status line; other exports download normally and are not saved to Files.
