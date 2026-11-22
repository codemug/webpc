## Browse the library
slug: browse-the-library
summary: Inspect the library, then filter and sort the view.
keywords: library, browse, filter, sort, view, find, photos
tools: desktop.open_app, lightcraft.library_info, lightcraft.filter, lightcraft.sort

When: the user asks what is in the library, or wants a different view of it.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.library_info
3. call_tool tool=lightcraft.filter filter={"rating":4}
4. call_tool tool=lightcraft.sort key=captureDate ascending=true
Check: the filter keeps only matching photos in the view; library_info shows the counts.
Gotchas: filter= is a JSON object of filter keys (rating, ratingOp, flag, label, keyword, camera, date, ...); sort key= is captureDate, importDate, editDate, fileName, rating, fileSize or random; lightcraft.library_info also reports free space and worker state.

## Select photos
slug: select-photos
summary: Select photos by id, or clear the selection.
keywords: select, selection, choose, pick, ids, clear
tools: desktop.open_app, lightcraft.select, lightcraft.library_info

When: the user wants specific photos selected for an action.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.select ids=3, 7
Check: the action that follows (rate, rotate, delete) takes the ids it was given.
Gotchas: ids= takes a list of photo ids from the library view; omitting ids= clears the selection; most photo commands act on the selection when ids= is omitted.

## Rate photos
slug: rate-photos
summary: Rate the selection or given photos 0 to 5 stars.
keywords: rate, rating, stars, pick, reject, 5 star
tools: desktop.open_app, lightcraft.rate, lightcraft.filter

When: the user wants to rate photos.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.rate rating=4
3. call_tool tool=lightcraft.filter filter={"rating":4}
Check: the filtered view lists the rated photos.
Gotchas: rating= is 0 to 5; ids= names the photos, the selection when omitted; advance=true moves on when the photo leaves the view; rating 0 unrates.

## Rotate photos
slug: rotate-photos
summary: Rotate photos 90 degrees left or right.
keywords: rotate, straighten, orientation, turn, sideways
tools: desktop.open_app, lightcraft.rotate, lightcraft.undo

When: the user wants to rotate photos straight.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.rotate direction=right
Check: the photos show rotated 90 degrees.
Gotchas: direction=left rotates counter-clockwise; ids= names the photos, the selection when omitted; lightcraft.undo takes the rotation back.

## Delete and restore photos
slug: delete-and-restore-photos
summary: Delete photos to Recently Deleted, and restore them.
keywords: delete, remove, trash, restore, recently deleted, undo
tools: desktop.open_app, lightcraft.delete, lightcraft.restore

When: the user wants to delete photos, or get a deleted one back.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.delete ids=3
3. call_tool tool=lightcraft.restore ids=3
Check: the photo is gone after the delete and back after the restore.
Gotchas: delete moves photos to Recently Deleted (not permanent), so ask the user first and keep the ids for lightcraft.restore; ids= names the photos, the selection when omitted.

## Reset a photo's edits
slug: reset-photo-edits
summary: Reset the develop edits on a photo, back to the original.
keywords: reset, develop, edits, back to original, clear settings
tools: desktop.open_app, lightcraft.develop_reset, lightcraft.undo

When: the user wants all edits off a photo.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.develop_reset
Check: the photo shows the original, unedited image.
Gotchas: develop_reset clears the edit history of the photo, so the user should confirm; ids= names the photos, the selection when omitted; a single edit is better undone with lightcraft.undo.

## Undo and redo changes
slug: undo-and-redo
summary: Step back through and forward through the library's changes.
keywords: undo, redo, back, step back, history
tools: desktop.open_app, lightcraft.undo, lightcraft.redo

When: the user wants to undo or redo a change.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.undo
3. call_tool tool=lightcraft.redo
Check: the change is gone after undo and back after redo.
Gotchas: undo and redo walk the journal one step at a time; a deleted photo is brought back with lightcraft.restore instead.

## Run any library command
slug: run-any-lightcraft-command
summary: Run a LightCraft command by id, e.g. presets, masks, albums.
keywords: command, run, preset, mask, album, version, menu
tools: desktop.open_app, lightcraft.run_command, lightcraft.library_info

When: the user wants an action that has no dedicated tool.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.run_command command=album.setCover params="id=2 photo=9"
Check: lightcraft.library_info or the app UI shows the action took effect.
Gotchas: params= takes key=value lines or a JSON object; the page has no command list, so the id must come from the app's menus (e.g. preset.apply, mask.invert, version.create); photo.delete, preset.delete and develop.reset are destructive, so ask the user first.
## Import a photo from Files
slug: import-a-photo-from-files
summary: Add a photo that is stored in Files to the LightCraft library.
keywords: import, add, from files, photo, library, cr2, raw, load
tools: desktop.open_app, lightcraft.import_file

When: the user wants to add a photo stored in Files to the LightCraft library.
Steps:
1. call_tool tool=desktop.open_app app=lightcraft
2. call_tool tool=lightcraft.import_file path=/Photos/trip/IMG_0001.cr2
Check: lightcraft.library_info shows one more photo in the library.
Gotchas: change path= to a photo the app can read (image, dng, nef, cr2, arw, raf, orf, rw2); LightCraft has a library, not documents, so there is no save copy; a file too large to open is refused and the reason shows in the app status line.
