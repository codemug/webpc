## Draw a circle
slug: draw-a-circle
summary: Draw a circle at a point with a radius - cadcraft.circle does it in one call.
keywords: circle, draw, radius, geometry, shape, door swing, round
tools: desktop.open_app, cadcraft.circle, cadcraft.command_line, cadcraft.inspect

When: the user wants a circle drawn in the drawing.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.circle center=30,15 radius=8
Check: cadcraft.inspect with entities=true lists the new circle.
Gotchas: center is x,y text (the user's own centre) and radius a number; never type the circle as a sentence into cadcraft.command_line - the flat tool draws it in one call, and the command line only takes the exact form circle x,y n when the flat tool is unavailable; when no drawing is open the error names cadcraft.new_drawing.

## Draw a line
slug: draw-a-line
summary: Draw a line between two points - cadcraft.line does it in one call.
keywords: line, draw, segment, points, geometry, wall
tools: desktop.open_app, cadcraft.line, cadcraft.script, cadcraft.inspect

When: the user wants a line or segment drawn.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.line p1=30,15 p2=40,15
Check: cadcraft.inspect with entities=true lists the new line.
Gotchas: p1 and p2 are x,y points in the user's own order; the command-line script form stays for several lines at once - one input per line, the pack appends the terminating blank line, a relative point is @dx,dy and a polar one @dist<angle>.

## Move the drawing
slug: move-the-entities
summary: Move everything, or chosen entities, by a dx, dy offset with cadcraft.move.
keywords: move, offset, shift, relocate, move everything, move drawing, by 7,9
tools: desktop.open_app, cadcraft.move, cadcraft.inspect

When: the user wants the drawing content (or some entities) moved by an offset.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.move dx=7 dy=9
Check: cadcraft.inspect shows the extents shifted by dx, dy, and undo lists a Move.
Gotchas: dx and dy are the offset as the user gives it (move by 7,9 is dx=7 dy=9); handles= takes comma-separated handle ids from cadcraft.inspect entities=true, and moving every entity means omitting it; never spell [x,y] arrays into cadcraft.run_command params text - the flat tool sends them as the engine wants.

## Run a command-line script
slug: run-a-cad-script
summary: Run several command-line inputs in sequence, one per line.
keywords: script, batch, sequence, multiple inputs, run
tools: desktop.open_app, cadcraft.script, cadcraft.inspect

When: the user wants several command-line inputs typed in one go.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.inspect
3. call_tool tool=cadcraft.script text=rectang\n30,15\n40,20
Check: cadcraft.inspect with entities=true lists the new geometry.
Gotchas: one input per line in text=; a blank line sends Enter; the pack appends the terminating blank line when it is missing; \n in the tool call is a real newline.

## See what is in the drawing
slug: inspect-the-drawing
summary: Read the drawing summary: entity counts, extents, layers, selection.
keywords: inspect, what is in, drawing summary, layers, extents
tools: desktop.open_app, cadcraft.inspect

When: the user asks what is in the drawing, or what layers it has.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.inspect
Check: the result has the entity counts, extents and layers.
Gotchas: pass entities=true with limit= to list geometry with handles; the default is the summary only.

## Find geometry by type or layer
slug: find-geometry
summary: List entities filtered by type, layer, selection or a window.
keywords: find, query, entities, filter, layer, type
tools: desktop.open_app, cadcraft.query_entities

When: the user wants a list of some geometry, e.g. all circles or everything on a layer.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.query_entities type=Circle limit=20
Check: the result has count (all matches) and the entity list.
Gotchas: change type= or layer=; window_x0, window_y0, window_x1, window_y1 (all four) limit to a box, crossing=false means entirely inside.

## Find text labels in the drawing
slug: find-text-labels
summary: Read the drawing texts: labels, notes and block attributes.
keywords: text, labels, notes, room names, titles
tools: desktop.open_app, cadcraft.find_text

When: the user wants to find room names, sheet titles or notes.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.find_text contains=Room
Check: the result lists each text with its insertion point and layer.
Gotchas: contains= matches any case; page more with offset=; a window box filters around the insertion points.

## Add a text label
slug: add-a-text-label
summary: Add a single-line text label at a point with a height - cadcraft.text does it in one call.
keywords: text, label, room name, note, title, height, annotation
tools: desktop.open_app, cadcraft.text, cadcraft.find_text

When: the user wants a text label, room name or note added to the drawing.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.text at=30,15 text=Lab 7 height=60
Check: cadcraft.find_text contains=Lab 7 lists the label.
Gotchas: at is the x,y insertion point and text= is the label the user gave; height is the text height in drawing units (omit it for the default) and rotation degrees (omit it for 0); never type the label as a sentence into cadcraft.command_line - the flat tool adds it in one call; reading labels back is cadcraft.find_text.

## Start a new drawing
slug: start-a-new-drawing
summary: Create a blank imperial or metric drawing.
keywords: new drawing, blank, metric, imperial, start fresh
tools: desktop.open_app, cadcraft.new_drawing, cadcraft.cancel

When: the user wants a fresh drawing to start from.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.new_drawing metric=true
Check: cadcraft.inspect shows the empty drawing with zero entities.
Gotchas: new_drawing replaces the open drawing (destructive; unsaved work is lost); metric=true picks metric units; to plot geometry after this, read cadcraft/draw-a-line (line segments) or cadcraft/draw-a-circle (circles) and use their script or command_line form; run_command takes key=value lines in params=, not JSON.

## Find and run any command
slug: run-any-command
summary: Look up a command by name, then run it with parameters.
keywords: command, run, menu, zoom, layer, what can it do
tools: desktop.open_app, cadcraft.list_commands, cadcraft.run_command

When: the user wants a command that has no dedicated tool.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.list_commands query=zoom
3. call_tool tool=cadcraft.run_command command=zoom params=mode=extents
Check: cadcraft.inspect shows the new view extents.
Gotchas: run_command takes key=value lines in params=; the command new replaces the drawing (unsaved work is lost).

## Open a drawing from Files
slug: open-a-drawing-from-files
summary: Open a drawing that is stored in Files in CADCraft.
keywords: open, load, from files, drawing, dxf, plan
tools: desktop.open_app, cadcraft.open_file

When: the user wants to open a drawing that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.open_file path=/CadCraft/base.dxf
Check: the result's opened field confirms the drawing loaded; cadcraft.inspect shows the opened drawing.
Gotchas: change path= to the Files path of a drawing (.dxf); the drawing opens alongside the open ones; while the open drawing has unsaved changes the app asks first whether to keep them.

## Save a copy of the drawing to Files
slug: save-a-drawing-copy-to-files
summary: Save the active drawing as a file in Files.
keywords: save, copy, to files, export, keep, dxf, write
tools: desktop.open_app, cadcraft.save_copy

When: the user wants to keep a copy of the active drawing in Files.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.save_copy path=/CadCraft/base.dxf
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; CADCraft saves .dxf files, so a .dwg target is refused with the .dxf path as the fix (the web build cannot write DWG); if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive); with no drawing open the tool says so and the fix is cadcraft.new_drawing.
