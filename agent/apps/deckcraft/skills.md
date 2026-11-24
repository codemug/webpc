## Start a new presentation
slug: start-a-new-presentation
summary: Start a new themed or blank presentation, then add the first slides.
keywords: new presentation, new deck, start, theme, blank, slides
tools: desktop.open_app, deckcraft.new_presentation, deckcraft.add_slide, deckcraft.inspect

When: the user wants a new presentation or deck to start building.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.new_presentation theme=Harbor
3. call_tool tool=deckcraft.add_slide layout=titleAndContent title=Q1 Plan
Check: deckcraft.inspect lists the new slides.
Gotchas: new_presentation replaces the open presentation (destructive; unsaved work is lost); change theme= and the slide layout and title.

## Build a slide with text and a shape
slug: build-a-slide
summary: Add a slide, then fill it with a text box and a colored shape.
keywords: slide, build, text box, shape, layout, fill, heading
tools: desktop.open_app, deckcraft.add_slide, deckcraft.add_text_box, deckcraft.add_shape

When: the user wants a slide built with a heading and a visual element.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.add_slide layout=titleAndContent title=Q1 Plan
3. call_tool tool=deckcraft.add_text_box x=40 y=260 w=500 text=Key numbers size=24
4. call_tool tool=deckcraft.add_shape preset=rect x=40 y=420 w=300 h=80 fill=#3B5BDB
Check: deckcraft.inspect_slide shows the shapes with their ids.
Gotchas: change the coordinates and text; add_shape fills with fill= and outlines with line= (line=none removes the outline).

## Change text on a slide
slug: change-slide-text
summary: Read a slide, find the shape id, and replace its text.
keywords: change text, edit text, replace, shape text, title
tools: desktop.open_app, deckcraft.inspect_slide, deckcraft.set_text

When: the user wants to change the text of a shape or the title on a slide.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.inspect_slide index=0
3. call_tool tool=deckcraft.set_text id=7 text=Updated title
Check: deckcraft.inspect_slide shows the new text on the shape.
Gotchas: set_text takes the shape id from inspect_slide; leading tabs in text= set bullet levels.

## Add a table to a slide
slug: add-a-table
summary: Insert a table with rows and columns, filled with cell text.
keywords: table, grid, rows, columns, data, spreadsheet
tools: desktop.open_app, deckcraft.insert_table

When: the user wants a table of values on a slide.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.insert_table rows=3 cols=2 data=[["Item","Cost"],["Rent","1200"],["Food","400"]]
Check: deckcraft.inspect_slide lists the table on the current slide.
Gotchas: change rows= and cols=; data= rows must match cols; x, y, w, h place the table when all four are given.

## Add a chart to a slide
slug: add-a-chart
summary: Insert a chart with categories and one or more series.
keywords: chart, graph, plot, column, pie, data
tools: desktop.open_app, deckcraft.insert_chart

When: the user wants a chart or graph on a slide.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.insert_chart type=column title=Sales categories=Q1, Q2 series=[["Sales",12,18]]
Check: deckcraft.inspect_slide lists the chart on the current slide.
Gotchas: change type= (column, bar, line, pie, doughnut, area, scatter, stackedColumn); each series row is the name then its values.

## Select and format shapes
slug: select-and-format-shapes
summary: Select shapes by id and press the formatting shortcuts.
keywords: select, shape, format, bold, shortcut, style
tools: desktop.open_app, deckcraft.inspect_slide, deckcraft.select, deckcraft.key

When: the user wants to select shapes and apply a formatting shortcut.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.inspect_slide
3. call_tool tool=deckcraft.select ids=3, 4
4. call_tool tool=deckcraft.key key=B cmd=true
Check: deckcraft.inspect_slide shows the new formatting on the shapes.
Gotchas: ids= comes from inspect_slide; key= is a letter or name with shift, alt, cmd, ctrl modifiers.

## Find and run any menu command
slug: run-any-menu-command
summary: Look up a ribbon or menu command by name, then run it with parameters.
keywords: menu, ribbon, command, run action, toolbar, what can it do
tools: desktop.open_app, deckcraft.list_commands, deckcraft.run_command

When: the user wants a ribbon or menu action that has no dedicated tool.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.list_commands query=format
3. call_tool tool=deckcraft.run_command command=format.bold params=ids=3
Check: deckcraft.inspect_slide shows the action took effect.
Gotchas: run_command takes key=value lines in params=; ids starting with file.new, file.close or slide.delete are destructive (they replace, close or delete data).

## Do several slide edits at once
slug: do-several-slide-edits
summary: Run several slide commands in order in one batch call.
keywords: batch, several, at once, multiple edits, sequence
tools: desktop.open_app, deckcraft.batch

When: the user wants several slide changes applied in one go.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.batch commands="slide.new layout=title title=Q1, go_to_slide index=1"
Check: deckcraft.inspect lists the new slide and the current one.
Gotchas: each batch item is the command id then key=value tokens without spaces in values; keepGoing=true continues past a failing step.

## Open a presentation from Files
slug: open-a-presentation-from-files
summary: Open a presentation that is stored in Files in DeckCraft.
keywords: open, load, from files, deck, pptx, presentation
tools: desktop.open_app, deckcraft.open_file

When: the user wants to open a presentation that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.open_file path=/DeckCraft/talk.pptx
Check: the result's opened field names the deck and its slide count; deckcraft.inspect shows the opened presentation.
Gotchas: change path= to the Files path of a deck (.deckcraft, .pptx, .potx, .ppsx, or an outline); the deck opens alongside the open ones; while the open deck has unsaved changes the app asks first whether to keep them.

## Save a copy of the deck to Files
slug: save-a-deck-copy-to-files
summary: Save the active presentation as a file in Files.
keywords: save, copy, to files, export, keep, pptx, write
tools: desktop.open_app, deckcraft.save_copy

When: the user wants to keep a copy of the active presentation in Files.
Steps:
1. call_tool tool=desktop.open_app app=deckcraft
2. call_tool tool=deckcraft.save_copy path=/DeckCraft/talk.deckcraft
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; DeckCraft saves its own .deckcraft format, so a .pptx (or other) target is refused with the .deckcraft path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive); when the app saves through the capture path it also downloads the file, and the result says so.
