## Draw a diagram
slug: draw-a-diagram
summary: Add shapes, labels, lines and arrows to the canvas from a one-shape-per-line spec.
keywords: draw, diagram, flowchart, sketch, shapes, boxes, canvas, picture
tools: desktop.open_app, excalidraw.add_shapes

When: the user wants a diagram, flowchart or sketch drawn on the canvas.
Steps:
1. call_tool tool=desktop.open_app app=excalidraw
2. call_tool tool=excalidraw.add_shapes spec="rectangle 100 100 200 80 Start\nrectangle 400 100 200 80 End\narrow 1 2"
Check: excalidraw.list_elements shows the new shapes; the user sees them on the canvas.
Gotchas: change the spec; one shape per line (rectangle/ellipse/diamond x y w h [label], text x y label, line x1 y1 x2 y2, arrow A B); arrow numbers are 1-based shape line numbers and must come after the lines they join.

## Add a label
slug: add-a-label
summary: Add a free text label at a canvas position.
keywords: label, caption, text, note, title, write on canvas
tools: desktop.open_app, excalidraw.add_text

When: the user wants a caption, note or standalone label on the canvas.
Steps:
1. call_tool tool=desktop.open_app app=excalidraw
2. call_tool tool=excalidraw.add_text text=Q3 roadmap x=20 y=20
Check: excalidraw.list_elements shows the new text element.
Gotchas: change text=, x= and y=; canvas coordinates, not screen pixels; use add_shapes instead when the text should sit inside a shape.

## See what is on the canvas
slug: see-the-canvas
summary: List the elements on the canvas with their type and position.
keywords: what is on, list, elements, canvas, contents, show drawing
tools: desktop.open_app, excalidraw.list_elements

When: the user asks what is on the canvas, or before drawing more on top of it.
Steps:
1. call_tool tool=desktop.open_app app=excalidraw
2. call_tool tool=excalidraw.list_elements
Check: the result has count and one row per element (id, type, x, y, width, height; text for labels).
Gotchas: read-only; the rows are the anchor for what to draw next, so use them before add_shapes.

## Fit everything in view
slug: fit-everything-in-view
summary: Zoom the canvas so all content fits in view.
keywords: zoom to fit, fit view, show everything, zoom out, see all
tools: desktop.open_app, excalidraw.fit_view

When: the user says zoom to fit, show everything or fit the view.
Steps:
1. call_tool tool=desktop.open_app app=excalidraw
2. call_tool tool=excalidraw.fit_view
Check: the user sees the whole drawing in the viewport.
Gotchas: changes only the viewport, not the drawing; it is a no-op on an empty canvas.

## Connect two shapes with an arrow
slug: connect-shapes-with-an-arrow
summary: Draw an arrow between two existing or new shapes in one spec.
keywords: arrow, connect, link, point from, join, flow between
tools: desktop.open_app, excalidraw.add_shapes, excalidraw.list_elements

When: the user wants an arrow from one shape to another.
Steps:
1. call_tool tool=desktop.open_app app=excalidraw
2. call_tool tool=excalidraw.list_elements
3. call_tool tool=excalidraw.add_shapes spec="rectangle 100 100 200 80 First\nrectangle 400 100 200 80 Second\narrow 1 2"
Check: excalidraw.list_elements shows an arrow element whose position runs between the two shapes.
Gotchas: change the spec; arrow line numbers are 1-based shape line numbers within the same spec, so for shapes already on the canvas draw them in the same spec first.

## Clear the canvas
slug: clear-the-canvas
summary: Delete every element on the canvas; undo is lost too.
keywords: clear, empty, wipe, delete everything, blank canvas, reset drawing
tools: desktop.open_app, excalidraw.clear

When: the user wants the whole canvas emptied.
Steps:
1. call_tool tool=desktop.open_app app=excalidraw
2. call_tool tool=excalidraw.clear
Check: excalidraw.list_elements shows count 0.
Gotchas: this is destructive and also clears the undo history, so ask the user to confirm first and offer to list or export the drawing before clearing.
