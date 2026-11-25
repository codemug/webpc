## Read the document
slug: read-the-document
summary: Read the document text with a stable paraId per paragraph for follow-up edits.
keywords: read, show, what is in, document, text, content, document text
tools: desktop.open_app, docs.get_text

When: the user asks what is in the document, or before planning an edit.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.get_text
Check: the result has the text and each paragraph with its paraId.
Gotchas: each paragraph carries a stable paraId the edit tools take as para_id; the read reflects the live editor state, so it is fresh right after an edit.

## Type a paragraph
slug: type-a-paragraph
summary: Insert a new paragraph at the cursor, after a named paragraph, or at the end.
keywords: type, add, insert, paragraph, text, append, write into
tools: desktop.open_app, docs.insert_text

When: the user wants to add or type a paragraph of text into the document.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.insert_text text=Second draft notes
Check: docs.get_text shows the new paragraph.
Gotchas: change text=; with no para_id it goes at the cursor or the document end; the insert is applied as accepted text, not a pending suggestion.

## Make a heading
slug: make-a-heading
summary: Turn a paragraph into a heading of a given level.
keywords: heading, title, subheading, level, make bold heading, format line
tools: desktop.open_app, docs.set_heading

When: the user wants a line to become a heading, or to change a heading level.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.set_heading level=1
Check: docs.get_text shows the paragraph with the Heading style.
Gotchas: change level=; with no para_id it targets the paragraph at the cursor, so ask the user to click into the line first if needed.

## Find and replace
slug: find-and-replace
summary: Replace occurrences of a phrase across the document; the edits are applied in place.
keywords: find, replace, find and replace, rename word, swap, change every, change it to, instead
tools: desktop.open_app, docs.find_replace

When: the user wants find and replace across the document.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.find_replace find=draft replace=final
Check: the result counts the replacements applied.
Gotchas: change find= and replace=; a replace= with no text deletes the phrase; limit= caps how many matches are touched. changing a word in existing text needs docs.find_replace, not docs.insert_text, which only inserts a new paragraph. find_replace only edits text that is already in the open document - if the user gave you the sentence to type first, type it with docs.insert_text before replacing (a fresh document is empty, and "no occurrences" means the open document lacks the phrase).

## Bold the selection
slug: bold-the-selection
summary: Bold the current selection, or the whole paragraph under the cursor.
keywords: bold, emphasize, make bold, highlight text, strong
tools: desktop.open_app, docs.bold_selection

When: the user wants the selected text, or the line under the cursor, made bold.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.bold_selection
Check: docs.get_text shows the paragraph; ask the user to confirm the bold is where they wanted it.
Gotchas: the user must have a cursor or selection in the document first, so ask them to click into the text if the call reports no selection.

## Start a new document
slug: start-a-new-document
summary: Replace the document with a fresh one; the current content is lost.
keywords: new document, blank document, start over, fresh doc, clear document
tools: desktop.open_app, docs.new

When: the user wants to start over with a new document.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.new
Check: docs.get_text shows the new empty document.
Gotchas: this is destructive and keeps no recover-previous copy, so offer to export or read the old text first.

## Make a list
slug: make-a-list
summary: Make a range of lines a bulleted or numbered list.
keywords: list, bullet, bulleted, numbered, checklist, items, enumerate
tools: desktop.open_app, docs.get_text, docs.make_list

When: the user wants lines formatted as a bullet or numbered list.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.get_text
3. call_tool tool=docs.make_list kind=bullet from_text=first line to_text=last line
Check: the result names the lines it turned into a list; ask the user to confirm the bullets show.
Gotchas: from_text= and to_text= are the exact text of the first and last line (docs.get_text shows them); to_text= omitted means a one-line list; the cursor must be in the text, so ask the user to click into it if the call says so.

## Insert a line after a paragraph
slug: insert-after-a-paragraph
summary: Insert a new line after the paragraph that has a given text.
keywords: insert after, after the line, mid document, between lines, add after
tools: desktop.open_app, docs.insert_after

When: the user wants a line after a specific paragraph, named by its text.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.insert_after text=the new line after=the anchor line
Check: docs.get_text shows the new line after the anchor paragraph.
Gotchas: after= is the exact text of the anchor paragraph (docs.get_text shows the paragraphs); the insert lands as accepted text, not a pending suggestion.

## Delete a section
slug: delete-a-section
summary: Delete the paragraphs from one line to another, inclusive.
keywords: delete, remove, section, drop, get rid of, cut out
tools: desktop.open_app, docs.get_text, docs.delete_section

When: the user wants a section (a heading and its lines) removed.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.get_text
3. call_tool tool=docs.delete_section from_text=heading line to_text=last line of the section
Check: docs.get_text no longer shows the deleted lines and the rest of the document is intact.
Gotchas: this is destructive; from_text= and to_text= are the exact text of the first and last line to delete (to_text= omitted deletes one line); confirm the range with the user before deleting a long section.

## Move a section
slug: move-a-section
summary: Move the paragraphs from one line to another above a line, or to the top.
keywords: move, reorder, section, put first, on top, rearrange
tools: desktop.open_app, docs.get_text, docs.move_section

When: the user wants a section (a heading and its lines) reordered.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.get_text
3. call_tool tool=docs.move_section from_text=heading line to_text=last line of the section before_text=the line it goes above
Check: docs.get_text shows the section in the new place and every other line untouched.
Gotchas: from_text= and to_text= are the exact text of the first and last line of the section (to_text= omitted moves one line); before_text= is the exact text of the line the section goes above; omit before_text= to move the section to the top of the document. if to_text= equals from_text= only the heading line moves and the section's lines are left behind - read the section with docs.get_text and name its last line.

## Save the document to Files
slug: save-the-document-to-files
summary: Save the open document to Files as markdown or docx.
keywords: save, export, to files, markdown, docx, copy of the document, keep a copy
tools: desktop.open_app, docs.save

When: the user wants a copy of the open document in Files.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.save path=/docs/plan.md
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; the extension picks the format, .md saves markdown (headings and lists survive) and .docx saves the document as a Word file; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive); the open document keeps working after the save.

## Open a document from Files
slug: open-a-document-from-files
summary: Open a .md or .docx file from Files; the open document is replaced.
keywords: open, load, from files, import, continue working, that file
tools: desktop.open_app, docs.open

When: the user wants to open a saved document and keep working on it.
Steps:
1. call_tool tool=desktop.open_app app=docs
2. call_tool tool=docs.open path=/docs/plan.md
Check: docs.get_text shows the opened document's content.
Gotchas: change path= to the Files path of a .md or .docx file (files.find locates it); opening replaces the open document, so save the open one first if it has content worth keeping; markdown headings (# lines) become headings and list markers are dropped.
