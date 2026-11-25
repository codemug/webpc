## Type values into cells
slug: type-values-into-cells
summary: Write rows of values into the spreadsheet starting at a cell.
keywords: type, enter, input, cells, values, table, paste
tools: desktop.open_app, gridcraft.set_cells

When: the user wants to type, enter or paste a block of values into the spreadsheet.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Name","Price"],["Lamp",320]]
Check: gridcraft.read_range on the same range shows the values.
Gotchas: change start= and values=; the first row starts at start; a string starting with = becomes a formula; values= is a list of rows, each row a list of cells (a row is [["a","b"]], a column is [["a"],["b"]]); a flat list is refused, so wrap every row in its own list.

## Build a budget or plan with formula columns
slug: build-a-budget-with-formula-columns
summary: Type the whole table in one set_cells call: the header, each data row with its own formula, and the totals row with SUM.
keywords: budget, plan, balance, remaining, running total, column of dates, monthly, quarterly, quarter, three months, months, formula column, income, expense
tools: desktop.open_app, gridcraft.set_cells, gridcraft.read_range, gridcraft.get_cell

When: the user wants a budget, plan or monthly table with calculated columns (left, remaining, balance).
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Date","Income","Expenses","Left"],["2026-01-01",840,510,"=B2-C2"],["2026-02-01",840,630,"=B3-C3"],["2026-03-01",840,470,"=B4-C4"],["Total","=SUM(B2:B4)","=SUM(C2:C4)","=SUM(D2:D4)"]]
Check: gridcraft.read_range range=A1:D5 shows every row; gridcraft.get_cell on D3 shows =B3-C3 and its computed value.
Gotchas: one set_cells call writes the whole table - header, every data row with its own per-row formula, the totals row; do not type the rows cell by cell with set_cell. change the dates, the numbers and the column letters; a cell starting with = is a formula; the totals row sums the data rows only; a running Balance column adds each row's Left to the row above (E3 =E2+D3), first Balance row the opening balance as a plain number.

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

## Look up a value in a table
slug: look-up-a-value
summary: Look up a value by a key with VLOOKUP or XLOOKUP, or INDEX with MATCH.
keywords: lookup, look up, vlookup, xlookup, index, match, find value, price by id, key value
tools: desktop.open_app, gridcraft.set_cells, gridcraft.set_cell, gridcraft.get_cell, gridcraft.list_functions

When: the user wants a value looked up in a table by a key (a price by product id), or asks which lookup function to use.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["ID","Price"],["A1",9.5],["B2",14.25]]
3. call_tool tool=gridcraft.set_cell cell=D2 input==VLOOKUP(C2,A2:B3,2,0)
Check: gridcraft.get_cell on D2 shows the looked-up price; gridcraft.list_functions search=vlookup lists the signature.
Gotchas: step 2 only when the table is not already in the sheet. VLOOKUP(key, table, column, 0) reads the column to the right of the key, 0 = exact match; XLOOKUP(key, key column, value column) needs no column number; INDEX(value column, MATCH(key, key column, 0)) works when the value sits left of the key.

## Fill a formula down a column
slug: fill-a-formula-down-a-column
summary: Write the formula in the first data row, select the range and fill it down.
keywords: fill down, fill, formula column, drag down, repeat the formula, every row
tools: desktop.open_app, gridcraft.set_cell, gridcraft.select, gridcraft.run_command

When: the user wants one formula applied to a whole column of rows.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cell cell=D2 input==B2-C2
3. call_tool tool=gridcraft.select range=D2:D4 active=D2
4. call_tool tool=gridcraft.run_command command=edit.fillDown
Check: gridcraft.read_range range=D2:D4 shows each row's own formula (D3 holds =B3-C3, D4 holds =B4-C4).
Gotchas: change the cell, the formula and the range; the range starts at the formula's row and ends at the last data row, and active= is the formula's row; the fill rewrites each reference relative to its own row; the same result can be typed as one set_cells call with each row's formula, but the fill is the shorter way.

## Add a sheet and use it in a formula
slug: add-a-sheet-and-use-it-in-a-formula
summary: Insert a second sheet and read its cells from a formula on the first.
keywords: new sheet, add sheet, second sheet, cross-sheet, other sheet, reference another sheet
tools: desktop.open_app, gridcraft.run_command, gridcraft.set_cell, gridcraft.get_cell, gridcraft.inspect

When: the user wants a second sheet whose cells a formula on the first sheet reads.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.run_command command=home.insertSheet params=name=Totals
3. call_tool tool=gridcraft.set_cell cell=Totals!B2 input=34
4. call_tool tool=gridcraft.set_cell cell=A4 input==Totals!B2*2
Check: gridcraft.get_cell on A4 shows the value 68; gridcraft.inspect lists the Totals sheet.
Gotchas: change the sheet name and the cells; command= is the engine id home.insertSheet, not this skill's name (skill names have dashes, command ids do not) - if run_command says unknown command, copy the id from gridcraft.list_commands; a sheet-qualified reference Sheet!Cell works in set_cell and in formulas with the exact name the sheet was inserted with; the first sheet's cells stay writable as plain A1 references.

## Make cells bold or currency
slug: make-cells-bold-or-currency
summary: Bold, color, align or number-format a range of cells in one call.
keywords: bold, italic, currency, format, color, align, highlight
tools: desktop.open_app, gridcraft.set_cells, gridcraft.format_range

When: the user wants cells bold, italic, colored, aligned or currency-formatted.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Name","Price"],["Lamp",320],["Chair",38],["Table",25]]
3. call_tool tool=gridcraft.format_range range=A1:B1 bold=true
4. call_tool tool=gridcraft.format_range range=B2:B4 number_format=Currency
Check: gridcraft.get_cell on a formatted cell shows the style; the values are unchanged.
Gotchas: if the values are not already in the sheet, type them in step 2 (the rows form, change the values) and format the range they landed in; skip step 2 when the data is there. format exactly the cells the user named - the header row for the bold, the value column for the currency - not the whole block (A1:B4 styles the data too); change range= and the style params; pass at least one of bold, italic, font_color, fill, number_format or align.

## Make a chart from a range
slug: make-a-chart
summary: Insert a chart from a data range, with the headers as names.
keywords: chart, graph, plot, visualize, column, pie
tools: desktop.open_app, gridcraft.set_cells, gridcraft.insert_chart

When: the user wants a chart or graph made from a range of cells.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Metric","Count"],["Jan",64],["Feb",92]]
3. call_tool tool=gridcraft.insert_chart range=A1:B3 type=column title=Metrics
Check: gridcraft.inspect lists the new chart on the sheet.
Gotchas: if the data is not already in the sheet, type the user's values in step 2 (the rows form) and chart the range they landed in; skip step 2 when the data is there. the range= is the data block including the header row, with no sheet name (range=A1:B3, not Metric!A1:B3 - a header word is not a sheet); the first row and column become series names and categories.

## Turn a range into a table
slug: make-a-table
summary: Format a range as a table with banded rows and filter buttons.
keywords: table, format as table, banded, filter buttons, header
tools: desktop.open_app, gridcraft.set_cells, gridcraft.create_table

When: the user wants to turn a range of cells into a table.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Product","Stock"],["Lamp",38],["Chair",55]]
3. call_tool tool=gridcraft.create_table range=A1:B3 name=Stocklist
Check: gridcraft.inspect lists the new table with its name and range.
Gotchas: if the data is not already in the sheet, type the user's values in step 2 (the rows form) and table the range they landed in; skip step 2 when the data is there. range= covers exactly the data block including the header row - a table over an empty range picks up phantom columns; name= is the table name the user gave.

## Sort rows
slug: sort-rows
summary: Sort the rows of a range by one or more columns.
keywords: sort, order, arrange rows, ascending, descending
tools: desktop.open_app, gridcraft.set_cells, gridcraft.sort_range

When: the user wants to sort the rows, or put a column in order.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Name","Score"],["Gus",74],["Hal",91]]
3. call_tool tool=gridcraft.sort_range keys=B desc range=A1:B3 header=true
Check: gridcraft.read_range on the range shows the rows sorted by column B.
Gotchas: if the rows are not already in the sheet, type the user's values in step 2 (the rows form) and sort the range they landed in; skip step 2 when the data is there. keys= is a letter, or a letter plus desc for descending; range= covers the data block including the header; header=true keeps the first row in place.

## Filter rows
slug: filter-rows
summary: Keep only the rows that match a column filter.
keywords: filter, hide rows, show only, match, clear filter
tools: desktop.open_app, gridcraft.set_cells, gridcraft.filter

When: the user wants to filter rows, or hide the rows that do not match.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Product","Region"],["Lamp","North"],["Chair","South"]]
3. call_tool tool=gridcraft.filter column=B values=North range=A1:B3
Check: gridcraft.read_range shows only the matching rows; gridcraft.filter with clear=true removes the filter.
Gotchas: if the rows are not already in the sheet, type the user's values in step 2 (the rows form) and filter the range they landed in; skip step 2 when the data is there. column= is the letter of the filtered column, range= the data block including the header; custom_op plus custom_value filters by comparison, top_count keeps the top N rows.

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
Gotchas: change path= to the Files path of a workbook (xlsx, xlsm, xls, ods, csv, tsv, txt, json); the workbook opens alongside the open ones; while the open workbook has unsaved changes the app asks first whether to keep them; if the user is building from scratch and no path was given, do not open - either gridcraft.new_workbook or type the values straight into the active sheet (type-values-into-cells).

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

## Total a column by category
slug: total-a-column-by-category
summary: Build a per-category totals block with SUMIF formulas next to the data, one row per category.
keywords: spreadsheet, sumif, subtotal, group total, by category, summary block, formula block
tools: desktop.open_app, gridcraft.read_range, gridcraft.set_cells, gridcraft.get_cell

When: the user wants per-category totals in the sheet: one SUMIF row per group, next to the data.
Steps:
1. call_tool tool=desktop.open_app app=gridcraft
2. call_tool tool=gridcraft.set_cells start=A1 values=[["Region","Units"],["North",26],["South",34]]
3. call_tool tool=gridcraft.read_range range=A1:E10
4. call_tool tool=gridcraft.set_cells start=G1 values=[["Category","Total"],["North","=SUMIF(B2:B9,\"North\",D2:D9)"],["South","=SUMIF(B2:B9,\"South\",D2:D9)"]]
Check: gridcraft.get_cell on each total cell shows the computed number; the best category is the row with the biggest total.
Gotchas: if the data is not already in the sheet, type the user's values in step 2 (the rows form) and point the SUMIF ranges at them; skip step 2 and read the existing data in step 3 (so the column letters and the row range are right - read the sheet before writing the formulas). the block goes in a clear column to the right of the data (G1 when it ends at E) - writing it over the table destroys the data the SUMIFs read. quote the SUMIF criterion; keep the row form of values (a flat list is refused with both forms); a per-category total is a SUMIF, not a plain SUM.
