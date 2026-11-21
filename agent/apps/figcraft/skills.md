## Design a mobile screen
slug: design-a-mobile-screen
summary: Build one mobile app screen in a phone frame with auto layout and real text.
keywords: mobile, phone, screen, app, ui, frame, login, settings
tools: desktop.open_app, figcraft.new_document, figcraft.run_command, figcraft.set_properties, figcraft.create_node, figcraft.inspect_document

When: the user wants a mobile app screen designed, e.g. login, settings or an order summary.
Steps:
1. call_tool tool=desktop.open_app app=figcraft
2. call_tool tool=figcraft.new_document
3. call_tool tool=figcraft.run_command command=frame.create params=preset=iPhone 16\nx=0\ny=0\nname=Login
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
3. call_tool tool=figcraft.create_node type=rectangle x=40 y=40 width=200 height=120 name=Card props=cornerRadius=12
4. call_tool tool=figcraft.set_properties ids=5 props=fill=#3B5BDB\nopacity=0.9
5. call_tool tool=figcraft.get_node id=5 depth=1
Check: step 5 shows the fill and corner radius on the new layer.
Gotchas: change the type, position and size; ids in step 4 is the id from step 3; text= on a text layer types its characters.

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
