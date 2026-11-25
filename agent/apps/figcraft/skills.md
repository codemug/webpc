## Design a mobile screen
slug: design-a-mobile-screen
summary: Build one mobile app screen in a phone frame with auto layout and real text.
keywords: mobile, phone, screen, app, ui, frame, login, settings
tools: desktop.open_app, figcraft.new_document, figcraft.run_command, figcraft.set_properties, figcraft.create_node, figcraft.inspect_document

When: the user wants a mobile app screen designed, e.g. login, settings or an order summary.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.new_document
3. call_tool tool=figcraft.run_command command=frame.create params=preset=iPhone 16\nx=0\ny=0\nname=Canvas
4. call_tool tool=figcraft.set_properties ids=1 props=fill=#FFFFFF\nlayout=vertical\npadding=[64,24,32,24]\ngap=16\nsizingV=fixed
5. call_tool tool=figcraft.create_node parent=1 type=text text=Welcome back props=fontSize=28\nfontStyle=Bold
6. call_tool tool=figcraft.create_node parent=1 type=frame name=Email props=layout=horizontal\npadding=16\ncornerRadius=12\nstroke=#E0E0E0\nsizingH=fill
Check: figcraft.inspect_document depth=2 shows the frame, the title and the field.
Gotchas: Adapted from figcraft@v0.18.1 prompts.rs mobile_screen. Change the screen name and colors (brand default #3B5BDB); keep spacing on an 8-point grid and text left-aligned; the frame id from step 3 is the parent for the content.

## Start a design system
slug: start-a-design-system
summary: Create color variables, paint and text styles, and a button component.
keywords: design system, styles, variables, component, brand, tokens
tools: desktop.open_app, figcraft.new_document, figcraft.run_command, figcraft.create_node, figcraft.inspect_document

When: the user wants to set up a design system with colors and a button component.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.new_document
3. call_tool tool=figcraft.run_command command=variable.createCollection params=name=Core colours\nmodes=[Light,Dark]
4. call_tool tool=figcraft.run_command command=variable.create params=name=color/primary\nvalues={"Light":"#3B5BDB","Dark":"#2F4BC0"}
5. call_tool tool=figcraft.create_node type=frame name=Button props=layout=horizontal\nmainAlign=center\npadding=[12,20,12,20]\ncornerRadius=8\nfill=#3B5BDB
6. call_tool tool=figcraft.run_command command=component.create params=id=2
Check: figcraft.inspect_document shows the collection, the styles and the component.
Gotchas: Adapted from figcraft@v0.18.1 prompts.rs design_system. Make the swatch or text layers first, then style.create from their ids; make a secondary variant, then component.combineVariants; figcraft.list_commands query=variable shows the exact params.

## Design a landing page
slug: design-a-landing-page
summary: Build a desktop marketing page: nav, hero, features, CTA and footer.
keywords: landing page, website, marketing, hero, nav, footer, section
tools: desktop.open_app, figcraft.new_document, figcraft.create_node, figcraft.set_properties, figcraft.batch, figcraft.inspect_document

When: the user wants a landing page or marketing website designed.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.new_document
3. call_tool tool=figcraft.create_node type=frame x=0 y=0 width=1440 height=2400 name=Landing props=fill=#FFFFFF\nlayout=vertical\ngap=0
4. call_tool tool=figcraft.create_node parent=1 type=frame name=Nav props=layout=horizontal\nmainAlign=spaceBetween\npadding=[20,80,20,80]\nsizingH=fill
5. call_tool tool=figcraft.create_node parent=1 type=frame name=Hero props=layout=vertical\nmainAlign=center\npadding=120\ngap=24\nsizingH=fill
6. call_tool tool=figcraft.set_properties ids=1 props=sizingV=hug
Check: figcraft.inspect_document depth=2 shows the sections under the Landing frame.
Gotchas: Adapted from figcraft@v0.18.1 prompts.rs landing_page. Features cards: cornerRadius=16, padding=32, a soft dropShadow effect, each sizingH=fill; a CTA band filled with the accent (default #7048E8) and white text; use figcraft.batch to style several cards in one undo step.

## Wire a prototype flow
slug: wire-a-prototype-flow
summary: Connect screens with click interactions and add a flow start.
keywords: prototype, flow, interaction, click, navigate, transition, screens
tools: desktop.open_app, figcraft.new_document, figcraft.run_command, figcraft.get_node, figcraft.inspect_document

When: the user wants screens connected into a clickable prototype.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.new_document
3. call_tool tool=figcraft.run_command command=frame.create params=preset=iPhone 16\nx=0\ny=0\nname=Home
4. call_tool tool=figcraft.run_command command=proto.interaction.add params=id=5\ntrigger={"type":"onClick"}\naction={"type":"navigate","dest":9}\ntransition={"type":"smartAnimate"}\ndurationMs=300
5. call_tool tool=figcraft.run_command command=proto.flow.add params=start=1\nname=Main flow
6. call_tool tool=figcraft.get_node id=5 depth=1
Check: step 6 shows the interactions on the button; figcraft.inspect_document shows the page flows.
Gotchas: Adapted from figcraft@v0.18.1 prompts.rs prototype_flow. id and dest are layer ids from inspect; transitions: instant, dissolve, smartAnimate, moveIn, push, slideIn; add a back button on later screens with action {"type":"back"}.

## Fix the open comments
slug: fix-open-comments
summary: Read the open comment threads, fix each one, reply and resolve it.
keywords: comments, feedback, review, resolve, reply, fix notes
tools: desktop.open_app, figcraft.inspect_document, figcraft.run_command, figcraft.get_node, figcraft.set_properties, figcraft.batch

When: the user wants the open review comments addressed in the design.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.inspect_document
3. call_tool tool=figcraft.run_command command=comment.list params=page=all\nfilter=open
4. call_tool tool=figcraft.get_node id=7 depth=2
5. call_tool tool=figcraft.set_properties ids=7 props=fontSize=24
6. call_tool tool=figcraft.run_command command=comment.reply params=id=12\ntext=Increased the title size to 24\nauthor=AI
7. call_tool tool=figcraft.run_command command=comment.resolve params=id=12
Check: figcraft.comment.list via run_command shows the thread resolved and the fix in the layer.
Gotchas: Adapted from figcraft@v0.18.1 prompts.rs fix_comments. Reply before resolving (a reply reopens the thread); verify with get_node (this pack has no screenshot tool); put one thread's edits in one figcraft.batch; leave ambiguous threads open with a question, never resolved.

## Create a shape layer
slug: create-a-shape-layer
summary: Create a rectangle, ellipse or other shape, styled in one pass.
keywords: shape, rectangle, box, ellipse, circle, corner radius, fill
tools: desktop.open_app, figcraft.inspect_document, figcraft.create_node, figcraft.set_properties, figcraft.get_node

When: the user wants a simple shape added to the design.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.inspect_document
3. call_tool tool=figcraft.create_node type=rectangle x=40 y=40 width=200 height=120 name=Tile props=cornerRadius=12
4. call_tool tool=figcraft.set_properties ids=5 props=fill=#3B5BDB\nopacity=0.9
5. call_tool tool=figcraft.get_node id=5 depth=1
Check: step 5 shows the fill and corner radius on the new layer.
Gotchas: change the type, position and size; ids in step 4 is the id from step 3; text= on a text layer types its characters.

## Create a text layer
slug: create-a-text-layer
summary: Add a text layer with the characters, position and size the user names.
keywords: text, label, caption, headline, characters, letters, type, write, proof
tools: desktop.open_app, figcraft.new_document, figcraft.create_node, figcraft.inspect_document

When: the user wants text added to the design - a label, caption, headline or a proof text layer.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.new_document name=Proof
3. call_tool tool=figcraft.create_node type=text text=Shipped early x=40 y=40
Check: the result's node carries the characters; figcraft.inspect_document lists the text layer with them.
Gotchas: the characters go in text= - name= is the layer's name, not the text; position and size are the top-level x= y= width= height=, not inside props=; props= takes key=value lines only (fontSize=24 fill=#3366FF), never a JSON object; step 2 is skipped when a document is already open.

## Undo and redo changes
slug: undo-and-redo
summary: Undo a change, then redo it, so the last move in the history is the change.
keywords: undo, redo, history, take back, practise, last move
tools: desktop.open_app, figcraft.new_document, figcraft.create_node, figcraft.undo, figcraft.redo, figcraft.inspect_document

When: the user wants to undo the last change or bring it back.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.new_document
3. call_tool tool=figcraft.create_node type=rectangle
4. call_tool tool=figcraft.undo
5. call_tool tool=figcraft.redo
Check: figcraft.inspect_document shows the layer is back after the redo and the page has exactly one child.
Gotchas: undo and redo take no parameters; step 2 is only needed when no document is open; the history's last move after step 5 is the create.

## Style the selection
slug: style-the-selection
summary: Style the selected layers: fill, stroke, corner radius, layout.
keywords: style, fill, color, stroke, layout, spacing, selection
tools: desktop.open_app, figcraft.inspect_document, figcraft.select, figcraft.set_properties, figcraft.undo

When: the user wants the selected layers restyled in one call.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.inspect_document
3. call_tool tool=figcraft.select ids=3, 4
4. call_tool tool=figcraft.set_properties props=fill=#3B5BDB\ncornerRadius=8
Check: figcraft.inspect_document shows the new properties on both layers.
Gotchas: set_properties acts on the selection when ids= is omitted; auto layout keys like layout and gap only apply to frames, components and instances; figcraft.undo takes back the step.

## Export the design
slug: export-the-design
summary: Export the selection or the page as png, svg or the file as fig.
keywords: export, png, svg, download, image, share
tools: desktop.open_app, figcraft.export, figcraft.select

When: the user wants an image or svg of the design, or the file itself.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.select ids=1
3. call_tool tool=figcraft.export format=svg
Check: the result carries the svg text (or base64 data for raster formats) plus the format.
Gotchas: ids= exports those layers composited; scale= multiplies raster output (default 1); format=fig exports the whole file; without a file path the data comes back in the result.

## Open a document from Files
slug: open-a-document-from-files
summary: Open or import a FigCraft document from Files: .figcraft, .svg, .fig, .json or an image.
keywords: open, load, from files, figcraft, document, import, svg, logo, fig
tools: desktop.open_app, figcraft.open_file, figcraft.inspect_document

When: the user wants to open a FigCraft document or import an SVG/other file stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.open_file path=/FigCraft/sample.svg
Check: the result's opened field names the pages; figcraft.inspect_document shows the page's children - an empty page (childCount 0) means nothing was imported.
Gotchas: open_file takes the Files path of any importable format - .figcraft, .svg, .fig, .json or an image, not only .figcraft, so an SVG logo is opened with this same call; the document opens alongside the open ones; while the open document has unsaved changes the app asks first whether to keep them.

## Check what is in the document
slug: check-document-contents
summary: Report the document's pages, shapes and counts; the way to confirm an import brought the artwork in.
keywords: count, how many, shapes, verify, check, what is in, import, artwork, page, layers
tools: desktop.open_app, figcraft.open_file, figcraft.inspect_document

When: the user asks how many shapes, pages or layers the document has, or wants to confirm an import landed.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.open_file path=/FigCraft/sample.svg
3. call_tool tool=figcraft.inspect_document depth=1
Check: read childCount from the inspect result and answer with that number, then STOP - the user asked a question, so no create_node, move, style or any other call after the inspect; the page must stay exactly as the import left it.
Gotchas: the page's child is the imported frame and its childCount is the number of imported shapes; if the document is already open skip step 2 and go straight to the inspect; what an SVG import leaves is one frame named after the file whose children are the imported shapes - that is what you will read, not something to create, so never rebuild or "fix" what the inspect shows (a page with childCount 0 means the import landed nothing, so open the file again).

## Save a copy of the design to Files
slug: save-a-design-copy-to-files
summary: Save the active FigCraft document as a .figcraft file in Files.
keywords: save, copy, to files, figcraft, export, keep, fig, write
tools: desktop.open_app, figcraft.save_copy

When: the user wants to keep a copy of the active design in Files.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.save_copy path=/FigCraft/app.figcraft
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; FigCraft saves .figcraft files, so a target with another extension is refused with the .figcraft path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive).
