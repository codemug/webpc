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
Gotchas: change find= and replace=; a replace= with no text deletes the phrase; limit= caps how many matches are touched. changing a word in existing text needs docs.find_replace, not docs.insert_text, which only inserts a new paragraph.

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
Gotchas: this is destructive and keeps no recover-previous copy, so ask the user to confirm first and offer to export or read the old text first.
