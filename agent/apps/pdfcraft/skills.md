## Check what is in the document
slug: check-the-document
summary: Read the open PDF: its state, page, zoom and mode.
keywords: document info, metadata, pages, what is in, inspect, bookmarks
tools: desktop.open_app, pdfcraft.doc_info, pdfcraft.doc_inspect

When: the user asks what is in the open PDF or how many pages it has.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.doc_info
Check: the result shows the document's state, page, zoom and mode; doc_inspect reads the same state.
Gotchas: both tools take no params and read the document's ui.state; the page's file.properties only opens the Properties dialog and returns nothing, so it is not a read tool.

## Find a phrase in the document
slug: find-a-phrase
summary: Find where a phrase occurs, with the pages and line positions.
keywords: find, search, phrase, where, locate, text
tools: desktop.open_app, pdfcraft.text_find

When: the user wants to know where a phrase or word appears.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.text_find query=invoice
Check: the result lists the matches in page order with line rectangles.
Gotchas: query= is case-insensitive; limit= caps the matches (default 500) and next pages the search.

## Replace text throughout
slug: replace-text
summary: Find and replace a phrase, keeping the paragraph formatting.
keywords: replace, swap, change all, find and replace, update text
tools: desktop.open_app, pdfcraft.text_find, pdfcraft.text_replace

When: the user wants a phrase replaced everywhere in the document.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.text_find query=2025
3. call_tool tool=pdfcraft.text_replace find=2025 replace=2026
Check: pdfcraft.text_find query=2025 no longer matches; the result of text_replace names the pages changed.
Gotchas: step 2 is optional once the phrase is known; replace= empty deletes the match; all=false replaces only the first match.

## Rotate pages
slug: rotate-pages
summary: Rotate pages by 90, 180 or 270 degrees.
keywords: rotate, landscape, portrait, turn, flip orientation
tools: desktop.open_app, pdfcraft.doc_info, pdfcraft.page_rotate

When: the user wants pages rotated to another orientation.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.doc_info
3. call_tool tool=pdfcraft.page_rotate degrees=90
Check: pdfcraft.doc_info still lists the same pages (rotation changes the size, which the state does not report).
Gotchas: degrees= is a multiple of 90, positive clockwise; undo with pdfcraft.edit_undo.

## Delete or duplicate pages
slug: delete-or-duplicate-pages
summary: Remove pages or insert copies of them, or a blank page.
keywords: delete page, remove page, duplicate, copy page, blank page, insert
tools: desktop.open_app, pdfcraft.doc_info, pdfcraft.page_delete, pdfcraft.page_duplicate, pdfcraft.page_insert_blank

When: the user wants to remove, copy or add pages in the document.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.doc_info
3. call_tool tool=pdfcraft.page_duplicate pages=1
Check: pdfcraft.doc_info shows one more page.
Gotchas: page_delete is destructive, so ask the user first; pages= takes 1-based numbers or ranges like 2-4; page_insert_blank at=2 puts the blank page before page 2.

## Write text onto a page
slug: write-text-on-a-page
summary: Add styled text to a page at a position.
keywords: add text, write, stamp, label, annotation, watermark
tools: desktop.open_app, pdfcraft.doc_info, pdfcraft.page_add_text

When: the user wants text written onto a page (a stamp, label or note).
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.doc_info
3. call_tool tool=pdfcraft.page_add_text page=1 text=CONFIDENTIAL x=50 y=50 size=24 bold=true
Check: pdfcraft.doc_info still shows the same page count; the text is page content, not a comment.
Gotchas: x= and y= are points from the top-left of the displayed page; width= sets the wrap width (default 200); font= is helvetica, times or courier.

## Add a link to a page
slug: add-a-page-link
summary: Add a clickable link over a page box to a URL or a page.
keywords: link, hyperlink, url, click, destination
tools: desktop.open_app, pdfcraft.doc_info, pdfcraft.link_add

When: the user wants a clickable link on a page.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.doc_info
3. call_tool tool=pdfcraft.link_add page=1 rect=50, 50, 200, 70 url=https://example.com
Check: the result reports the added link; clicking the box in a viewer opens the URL.
Gotchas: rect= is [x0, y0, x1, y1] in points from the top-left of the page; to_page= jumps to a page instead of a URL.

## Save or close the document
slug: save-or-close-the-document
summary: Save the changes, or close the document.
keywords: save, close, finish, discard changes, wrap up
tools: desktop.open_app, pdfcraft.doc_info, pdfcraft.doc_save, pdfcraft.doc_close

When: the user is done and wants to save, or wants to close the document.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.doc_info
3. call_tool tool=pdfcraft.doc_save
Check: doc_save reports the saved file; doc_close fails while changes are unsaved unless discard_changes=true.
Gotchas: doc_close and doc_save are destructive (close the document / write to disk), so ask the user first.

## Find and run any menu command
slug: run-any-menu-command
summary: Look up a PdfCraft command by name, then run it with parameters.
keywords: menu, command, run action, what can it do, toolbar
tools: desktop.open_app, pdfcraft.doc_info, pdfcraft.command_list, pdfcraft.run_command

When: the user wants a menu action that has no dedicated tool.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.doc_info
3. call_tool tool=pdfcraft.command_list query=page
4. call_tool tool=pdfcraft.run_command command=page.reverse params=
Check: pdfcraft.doc_info shows the new page order.
Gotchas: run_command takes key=value lines in params=; ids starting with file.close, file.save or page.delete are destructive, so ask the user first.

## Open a PDF from Files
slug: open-a-pdf-from-files
summary: Open a PDF that is stored in Files in PdfCraft.
keywords: open, load, from files, pdf, document, import
tools: desktop.open_app, pdfcraft.open_file

When: the user wants to open a PDF that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.open_file path=/PDFCraft/contract.pdf
Check: the result's opened field confirms the PDF loaded; pdfcraft.doc_info shows the opened PDF.
Gotchas: change path= to the Files path of a .pdf; the PDF opens as a new tab; while the open PDF has unsaved changes the app asks first whether to keep them; with no PDF open yet, open_file is how you get one.

## Save a copy of the PDF to Files
slug: save-a-pdf-copy-to-files
summary: Save the open PDF as a file in Files.
keywords: save, copy, to files, export, keep, pdf, write
tools: desktop.open_app, pdfcraft.save_copy

When: the user wants to keep a copy of the open PDF in Files.
Steps:
1. call_tool tool=desktop.open_app app=pdfcraft
2. call_tool tool=pdfcraft.save_copy path=/PDFCraft/contract.pdf
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; PDFCraft saves .pdf files, so a target with another extension is refused with the .pdf path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive); the app saves under the name the PDF was opened with and also downloads the file; with no PDF open the tool says so and the fix is to open one first.
