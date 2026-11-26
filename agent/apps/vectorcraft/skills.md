## Draw a rectangle or ellipse
slug: draw-a-rectangle
summary: Draw a rectangle, ellipse, polygon, star or line with a fill.
keywords: rectangle, box, ellipse, oval, circle, icon, shape, draw, polygon, star
tools: desktop.open_app, vectorcraft.new_document, vectorcraft.draw_shape, vectorcraft.inspect

When: the user wants a basic shape drawn in the drawing.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.new_document name=Icon
3. call_tool tool=vectorcraft.draw_shape shape=rectangle x=20 y=60 width=200 height=120 radius=12 fill=#7048E8
Check: vectorcraft.inspect depth=1 lists the new shape with its id and bounds.
Gotchas: new_document name= sets the document title (default Untitled-N), so give it the name the user asks for. The artboard size is new_document width= and height= (points) - "a 500 by 700 artboard" is the new_document call, not a rectangle to draw, so never draw the artboard as a shape. The geometry params change with shape - rectangle: x, y, width, height, radius (rounded corners); ellipse: x, y, width, height (it takes no radius); polygon: cx, cy, radius, sides; star: cx, cy, radius1, radius2, points; line: x1, y1, x2, y2. Every shape also takes fill=, stroke= and strokeWidth=; stroke=none removes the outline.

## Draw a path
slug: draw-a-path
summary: Draw a freeform or Bezier path from points or SVG path data.
keywords: path, curve, bezier, pen, freeform, line art, outline
tools: desktop.open_app, vectorcraft.new_document, vectorcraft.draw_path, vectorcraft.inspect

When: the user wants a custom path or shape outline drawn.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.new_document
3. call_tool tool=vectorcraft.draw_path d=M0 0 L100 0 L50 80 Z fill=#0CA678 stroke=none
Check: vectorcraft.inspect depth=1 lists the new path with its id.
Gotchas: d= is SVG path data; points= takes [x,y] pairs or {x,y,in,out} anchors with closed=true to close the path; omitting fill and stroke inherits the current new-art appearance.

## Paint the selection
slug: paint-the-selection
summary: Set the fill, stroke and stroke weight of the selected objects.
keywords: paint, color, fill, stroke, recolor, outline, weight
tools: desktop.open_app, vectorcraft.set_paint, vectorcraft.inspect

When: the user wants the selected objects painted a new color.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.inspect
3. call_tool tool=vectorcraft.set_paint fill=#7048E8 strokeWidth=2
Check: the reply says how many objects were painted; vectorcraft.inspect shows the new paint.
Gotchas: ids= names the objects; omit it to paint the selection; fill=none or stroke=none removes that paint; a note says when only the new-art default changed.

## Add text
slug: add-drawing-text
summary: Add point or area text at a position, or on a path.
keywords: text, label, title, caption, write, letters, heading, headline
tools: desktop.open_app, vectorcraft.add_text, vectorcraft.inspect

When: the user wants text added to the drawing.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.inspect
3. call_tool tool=vectorcraft.add_text text=New title x=24 y=96 size=18 color=#0CA678
Check: one vectorcraft.inspect after the single add_text lists the new text object with the requested colour - a successful add_text already created the layer, so read it back instead of calling add_text again.
Gotchas: ONE add_text call per text layer - a second call (for example re-adding the same text with width= and height=) creates a second object that reads back first and shadows the first. Point text takes size= (the point size); width= and height= (both) make an area type with a frame, only when the user asks for wrapped or framed text; path= flows the text in or along an existing path (mode=area or onPath); color=, font= and justify= style the text.

## Move or resize objects
slug: move-or-resize-objects
summary: Move, rotate, scale, reflect or shear the selected objects.
keywords: move, rotate, scale, resize, reflect, shear, reposition
tools: desktop.open_app, vectorcraft.inspect, vectorcraft.transform, vectorcraft.undo

When: the user wants objects moved, rotated or resized.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.inspect
3. call_tool tool=vectorcraft.transform dx=0 dy=24
4. call_tool tool=vectorcraft.transform rotate=90 origin=100, 100
Check: the reply lists the operations applied; vectorcraft.inspect shows the new bounds.
Gotchas: several operations combine in the order move, rotate, scale, reflect, shear; copy=true transforms a copy; origin= is [x, y]; vectorcraft.undo takes a step back.

## Combine shapes
slug: combine-shapes
summary: Boolean-combine shapes with the pathfinder operations.
keywords: combine, merge, unite, intersect, exclude, boolean, cut
tools: desktop.open_app, vectorcraft.inspect, vectorcraft.pathfinder, vectorcraft.undo

When: the user wants shapes combined or cut against each other.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.inspect
3. call_tool tool=vectorcraft.pathfinder operation=unite ids=3, 4
Check: vectorcraft.inspect lists one combined object instead of the two.
Gotchas: pathfinder combines destructively (back to front), so keep vectorcraft.undo ready; operation= is unite, minusFront, intersect, exclude, divide, trim, merge, crop, outline or minusBack.

## Apply an effect
slug: apply-an-effect
summary: Apply a live effect like a drop shadow, warp or blur.
keywords: effect, drop shadow, shadow, warp, blur, distort, stylize
tools: desktop.open_app, vectorcraft.apply_effect, vectorcraft.inspect

When: the user wants an effect on the selection, or the list of effects.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.inspect
3. call_tool tool=vectorcraft.apply_effect
4. call_tool tool=vectorcraft.apply_effect effect=stylize.dropShadow params=x=4\ny=4\nblur=6\nopacity=60
Check: vectorcraft.inspect shows the effect on the object.
Gotchas: step 3 returns the effect catalogue (ids, parameters, defaults) when effect= is omitted; params= takes key=value lines and missing keys take the dialog defaults; ids= names the objects.

## Find and run any command
slug: run-any-drawing-command
summary: Look up a VectorCraft command by name, then run it with parameters.
keywords: command, run, menu, what can it do, align, group, toolbar
tools: desktop.open_app, vectorcraft.inspect, vectorcraft.list_commands, vectorcraft.run_command

When: the user wants an action that has no dedicated tool.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.inspect
3. call_tool tool=vectorcraft.list_commands query=align
4. call_tool tool=vectorcraft.run_command command=object.align params=horizontal=left
Check: vectorcraft.inspect shows the action took effect.
Gotchas: run_command takes key=value lines in params= (a [ ... ] or { ... } value is JSON); object.delete, layer.delete, file.close and the pathfinder ids are destructive (they delete objects or layers, or close the file).
## Open a document from Files
slug: open-a-document-from-files
summary: Open a VectorCraft document or import vector art that is stored in Files.
keywords: open, load, from files, vectorcraft, import, svg, vector
tools: desktop.open_app, vectorcraft.open_file

When: the user wants to open a document or import vector art that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.open_file path=/VectorCraft/draft.vectorcraft
Check: the result has an opened field confirming the document loaded; vectorcraft.inspect shows the open document.
Gotchas: change path= to a .vectorcraft document or an importable vector format (svg, pdf, ai); the wrapper has no page-API open control, so the file rides the wrapper's own open path.

## Save a copy of the drawing to Files
slug: save-a-drawing-copy-to-files
summary: Save the active VectorCraft document to Files as a .vectorcraft file or an export format.
keywords: save, copy, to files, vectorcraft, export, keep, write
tools: desktop.open_app, vectorcraft.save_copy

When: the user wants to keep a copy of the active drawing in Files.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.save_copy path=/VectorCraft/draft.vectorcraft
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; the extension picks the format (.vectorcraft by default, or an export format like .svg or .pdf); an extension the app cannot serialize is refused with the .vectorcraft path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive).

## Undo and redo a change
slug: undo-and-redo
summary: Undo a drawing change, then redo it, so the last move in the history is the change.
keywords: undo, redo, history, take back, bring back, star
tools: desktop.open_app, vectorcraft.new_document, vectorcraft.draw_shape, vectorcraft.undo, vectorcraft.redo, vectorcraft.inspect

When: the user wants to undo the last change in a drawing and then bring it back.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.new_document name=Star
3. call_tool tool=vectorcraft.draw_shape shape=star cx=200 cy=200 radius1=60 radius2=25
4. call_tool tool=vectorcraft.undo
5. call_tool tool=vectorcraft.redo
Check: vectorcraft.inspect kind=path shows exactly one path node after the redo - the star is back.
Gotchas: undo and redo take no parameters; step 2 is only when no document is open; the star uses cx, cy, radius1, radius2 (not x, y, width, height) and draws as a plain path node.
