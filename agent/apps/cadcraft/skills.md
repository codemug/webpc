## Draw a circle
slug: draw-a-circle
summary: Draw a circle at a point with a radius, straight from the command line.
keywords: circle, draw, radius, geometry, shape
tools: desktop.open_app, cadcraft.command_line, cadcraft.inspect

When: the user wants a circle drawn in the drawing.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.inspect
3. call_tool tool=cadcraft.command_line text=circle 0,0 5
Check: cadcraft.inspect with entities=true lists the new circle.
Gotchas: change the center and radius; spaces act as Enter, so the whole command runs in one call; step 2 checks the drawing is open and its error names cadcraft.new_drawing when it is not.

## Draw a line
slug: draw-a-line
summary: Draw a line between two points with the line command.
keywords: line, draw, segment, points, geometry
tools: desktop.open_app, cadcraft.command_line, cadcraft.script, cadcraft.inspect

When: the user wants a line or segment drawn.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.inspect
3. call_tool tool=cadcraft.script text=line\n0,0\n10,0\n (one input per line, the final blank line included)
Check: cadcraft.inspect with entities=true lists the new line.
Gotchas: LINE keeps asking for points; end the script with a blank line to finish, because a whitespace-only command_line call is rejected by the pack and a trailing space on the call that starts the command is swallowed, so a blank script line is the only reliable terminating Enter. Otherwise the next inputs feed the still-open command instead of starting a new one. A relative point is @dx,dy and a polar one @dist<angle.

## Run a command-line script
slug: run-a-cad-script
summary: Run several command-line inputs in sequence, one per line.
keywords: script, batch, sequence, multiple inputs, run
tools: desktop.open_app, cadcraft.script, cadcraft.inspect

When: the user wants several command-line inputs typed in one go.
Steps:
1. call_tool tool=desktop.open_app app=cadcraft
2. call_tool tool=cadcraft.inspect
3. call_tool tool=cadcraft.script text=rectang\n0,0\n10,5
Check: cadcraft.inspect with entities=true lists the new geometry.
Gotchas: one input per line in text=; a blank line sends Enter; \n in the tool call is a real newline.

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
Gotchas: new_drawing replaces the open drawing (destructive; unsaved work is lost); metric=true picks metric units.

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
2. call_tool tool=cadcraft.open_file path=/CadCraft/plan.dxf
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
2. call_tool tool=cadcraft.save_copy path=/CadCraft/plan.dxf
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; CADCraft saves .dxf files, so a .dwg target is refused with the .dxf path as the fix (the web build cannot write DWG); if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive); with no drawing open the tool says so and the fix is cadcraft.new_drawing.
