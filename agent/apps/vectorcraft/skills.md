## Draw a rectangle or ellipse
slug: draw-a-rectangle
summary: Draw a rectangle, ellipse, polygon, star or line with a fill.
keywords: rectangle, box, ellipse, circle, shape, draw, polygon, star
tools: desktop.open_app, vectorcraft.new_document, vectorcraft.draw_shape, vectorcraft.inspect

When: the user wants a basic shape drawn in the drawing.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.new_document
3. call_tool tool=vectorcraft.draw_shape shape=rectangle x=40 y=40 width=200 height=120 radius=12 fill=#7048E8
Check: vectorcraft.inspect depth=1 lists the new shape with its id and bounds.
Gotchas: change shape=, the size and the color; radius= rounds the rectangle corners; ellipse and polygon use cx, cy, radius=; line uses x1, y1, x2, y2; stroke=none removes the outline.

## Draw a path
slug: draw-a-path
summary: Draw a freeform or Bezier path from points or SVG path data.
keywords: path, curve, bezier, pen, freeform, line art, outline
tools: desktop.open_app, vectorcraft.new_document, vectorcraft.draw_path, vectorcraft.inspect

When: the user wants a custom path or shape outline drawn.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.new_document
3. call_tool tool=vectorcraft.draw_path d=M0 0 L100 0 L50 80 Z fill=#3B5BDB stroke=none
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
3. call_tool tool=vectorcraft.set_paint fill=#3B5BDB strokeWidth=2
Check: the reply says how many objects were painted; vectorcraft.inspect shows the new paint.
Gotchas: ids= names the objects; omit it to paint the selection; fill=none or stroke=none removes that paint; a note says when only the new-art default changed.

## Add text
slug: add-drawing-text
summary: Add point or area text at a position, or on a path.
keywords: text, label, title, caption, write, letters, heading
tools: desktop.open_app, vectorcraft.add_text, vectorcraft.inspect

When: the user wants text added to the drawing.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.inspect
3. call_tool tool=vectorcraft.add_text text=Title x=40 y=80 size=24
4. call_tool tool=vectorcraft.add_text text=Body copy x=40 y=120 width=400 height=100
Check: vectorcraft.inspect lists both text objects; the reply flags overflow when the text does not fit.
Gotchas: width= and height= (both) make area type; path= flows the text in or along an existing path (mode=area or onPath); color=, font= and justify= style the text.

## Move or resize objects
slug: move-or-resize-objects
summary: Move, rotate, scale, reflect or shear the selected objects.
keywords: move, rotate, scale, resize, reflect, shear, reposition
tools: desktop.open_app, vectorcraft.inspect, vectorcraft.transform, vectorcraft.undo

When: the user wants objects moved, rotated or resized.
Steps:
1. call_tool tool=desktop.open_app app=vectorcraft
2. call_tool tool=vectorcraft.inspect
3. call_tool tool=vectorcraft.transform dx=0 dy=40
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
Gotchas: pathfinder combines destructively (back to front), so ask the user first and keep vectorcraft.undo ready; operation= is unite, minusFront, intersect, exclude, divide, trim, merge, crop, outline or minusBack.

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
Gotchas: run_command takes key=value lines in params= (a [ ... ] or { ... } value is JSON); object.delete, layer.delete, file.close and the pathfinder ids are destructive, so ask the user first.
