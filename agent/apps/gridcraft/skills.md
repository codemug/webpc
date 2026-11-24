## Type values into cells
slug: type-values-into-cells
summary: Write rows of values into the spreadsheet starting at a cell.
keywords: type, enter, input, cells, values, table, paste
tools: desktop.open_app, gridcraft.set_cells

When: the user wants to type, enter or paste a block of values into the spreadsheet.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Item","Cost"],["Rent",1200]]
Check: gridcraft.read_range on the same range shows the values.
Gotchas: change start= and values=; the first row starts at start; a string starting with = becomes a formula.

## Read what is in cells
slug: read-cell-values
summary: Read the values of a range, or the whole used range of the sheet.
keywords: read, show, look at, cells, values, range, what is
tools: desktop.open_app, gridcraft.read_range

When: the user asks what is in some cells or a range of the spreadsheet.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.read_range range=A1:D10
Check: the result has the rows of cell values; empty cells are null.
Gotchas: change range=; omit it to read the used range; pass formulas=true to see formula text.

## Add a SUM formula
slug: add-a-sum-formula
summary: Put a SUM or other formula into a cell, and check the result first.
keywords: sum, total, formula, add up, calculate, average
tools: desktop.open_app, gridcraft.evaluate_formula, gridcraft.set_cell, gridcraft.get_cell

When: the user wants a total, average or other formula typed into a cell.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.evaluate_formula formula==SUM(B2:B9)
3. call_tool tool=gridcraft.set_cell cell=B10 input==SUM(B2:B9)
Check: gridcraft.get_cell on B10 shows the formula and its computed value.
Gotchas: change the range and the target cell; step 2 is optional once the formula is known.

## Make cells bold or currency
slug: make-cells-bold-or-currency
summary: Bold, color, align or number-format a range of cells in one call.
keywords: bold, italic, currency, format, color, align, highlight
tools: desktop.open_app, gridcraft.format_range

When: the user wants cells bold, italic, colored, aligned or currency-formatted.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.format_range range=A1:C1 bold=true
3. call_tool tool=gridcraft.format_range range=B2:B9 number_format=Currency
Check: gridcraft.get_cell on a formatted cell shows the style; the values are unchanged.
Gotchas: change range= and the style params; pass at least one of bold, italic, font_color, fill, number_format or align.

## Make a chart from a range
slug: make-a-chart
summary: Insert a chart from a data range, with the headers as names.
keywords: chart, graph, plot, visualize, column, pie
tools: desktop.open_app, gridcraft.insert_chart

When: the user wants a chart or graph made from a range of cells.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.insert_chart range=A1:C6 type=column title=Sales
Check: gridcraft.inspect lists the new chart on the sheet.
Gotchas: change range= (include the header row) and type=; the first row and column become series names and categories.

## Turn a range into a table
slug: make-a-table
summary: Format a range as a table with banded rows and filter buttons.
keywords: table, format as table, banded, filter buttons, header
tools: desktop.open_app, gridcraft.create_table

When: the user wants to turn a range of cells into a table.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.create_table range=A1:D20
Check: gridcraft.inspect lists the new table with its name and range.
Gotchas: change range= (include the header row); name= sets the table name, style= the look.

## Sort rows
slug: sort-rows
summary: Sort the rows of a range by one or more columns.
keywords: sort, order, arrange rows, ascending, descending
tools: desktop.open_app, gridcraft.sort_range

When: the user wants to sort the rows, or put a column in order.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.sort_range keys=B, A desc range=A1:D20 header=true
Check: gridcraft.read_range on the range shows the rows sorted by column B.
Gotchas: change keys= (a letter, or a letter plus desc for descending) and range=; header=true keeps the first row in place.

## Filter rows
slug: filter-rows
summary: Keep only the rows that match a column filter.
keywords: filter, hide rows, show only, match, clear filter
tools: desktop.open_app, gridcraft.filter

When: the user wants to filter rows, or hide the rows that do not match.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.filter column=C values=North, South
Check: gridcraft.read_range shows only the matching rows; gridcraft.filter with clear=true removes the filter.
Gotchas: change column= and values=; custom_op plus custom_value filters by comparison, top_count keeps the top N rows.

## Start a new workbook
slug: start-a-new-workbook
summary: Create a blank or sample workbook and make it active.
keywords: new workbook, new spreadsheet, blank book, sample, start fresh
tools: desktop.open_app, gridcraft.new_workbook

When: the user wants a new spreadsheet, or one of the built-in samples.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.new_workbook
Check: gridcraft.inspect shows the new workbook as active.
Gotchas: the open workbook stays open in the app; if it has unsaved work, tell the user before switching; sample= picks budget, sales or grades.

## Find and run any menu command
slug: run-any-menu-command
summary: Look up a ribbon or menu command by name, then run it with parameters.
keywords: menu, ribbon, command, run action, toolbar, what can it do
tools: desktop.open_app, gridcraft.list_commands, gridcraft.run_command

When: the user wants a ribbon or menu action that has no dedicated tool.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.list_commands query=border
3. call_tool tool=gridcraft.run_command command=home.borders params=range=A1:C1
Check: gridcraft.read_range or gridcraft.inspect shows the action took effect.
Gotchas: run_command takes key=value lines in params=; ids starting with file.new, file.close, sheet.delete or edit.clear are destructive (they replace, clear or close data).

## Open a workbook from Files
slug: open-a-workbook-from-files
summary: Open a workbook that is stored in Files in GridCraft.
keywords: open, load, from files, workbook, xlsx, import file
tools: desktop.open_app, gridcraft.open_file

When: the user wants to open a workbook that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.open_file path=/GridCraft/budget.xlsx
Check: the result's opened field names the workbook and its sheets; gridcraft.inspect shows the opened workbook.
Gotchas: change path= to the Files path of a workbook (xlsx, xlsm, xls, ods, csv, tsv, txt, json); the workbook opens alongside the open ones; while the open workbook has unsaved changes the app asks first whether to keep them.

## Save a copy of the workbook to Files
slug: save-a-workbook-copy-to-files
summary: Save the active workbook as a file in Files.
keywords: save, copy, to files, export, keep, xlsx, write
tools: desktop.open_app, gridcraft.save_copy

When: the user wants to keep a copy of the active workbook in Files.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.save_copy path=/GridCraft/budget.xlsx
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; GridCraft saves .xlsx files, so a target with another extension is refused with the .xlsx path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive); when the app saves through the capture path it also downloads the file, and the result says so.
