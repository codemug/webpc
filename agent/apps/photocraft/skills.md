## Open a document or image from Files
slug: open-a-document-from-files
summary: Open a .pcraft document or import an image that is stored in Files in PhotoCraft.
keywords: open, load, from files, pcraft, import, psd, photo, image
tools: desktop.open_app, photocraft.open_file

When: the user wants to open a PhotoCraft document or import an image that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=photocraft
2. call_tool tool=photocraft.open_file path=/PhotoCraft/scene.pcraft
Check: photocraft.status shows the wrapper opened the file; the document appears in the editor.
Gotchas: change path= to a .pcraft document or an importable image (psd, psb, xcf, ora, kra, pdn, or flat image); if the open document reports unsaved changes the wrapper asks first before opening the new file.

## Save a copy of the document to Files
slug: save-a-document-copy-to-files
summary: Save a copy of the PhotoCraft document as a .pcraft file in Files.
keywords: save, copy, to files, pcraft, export, keep, write
tools: desktop.open_app, photocraft.save_copy

When: the user wants to keep a copy of the PhotoCraft document in Files.
Steps:
1. call_tool tool=desktop.open_app app=photocraft
2. call_tool tool=photocraft.save_copy path=/PhotoCraft/scene.pcraft
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: the tool waits for the user to save in the editor; PhotoCraft saves .pcraft documents, so a target with another extension is refused with the .pcraft path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive).

## Edit photos and layers in the editor
slug: edit-photos-and-layers-in-the-editor
summary: PhotoCraft edits photos and layers non-destructively in its native editor; the agent opens the app and the user works the editor.
keywords: edit, photo, layers, non-destructive, adjust, mask, filter, retouch
tools: desktop.open_app, photocraft.status

When: the user wants to edit a photo or work its layers in PhotoCraft.
Steps:
1. call_tool tool=desktop.open_app app=photocraft
Check: the editor is open and showing the document; the user drives the native panels and tools directly.
Gotchas: the agent has no PhotoCraft editing tools, so it opens the app and the user works the editor; photocraft.status shows the wrapper status line; closing or reloading asks first while the open document has unsaved changes.
