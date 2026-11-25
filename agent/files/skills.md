## See what is in a folder
slug: see-what-is-in-a-folder
summary: List the folders and files inside one folder of the Files area.
keywords: see, list, show, what is in, folder contents
tools: files.list

When: the user asks what is in a folder, or which files are saved somewhere.
Steps:
1. call_tool tool=files.list path=/notes
Check: the result lists the folders and files inside /notes, folders first.
Gotchas: change path= to the folder to look in; omit it to list the Files root. files.list works without the Files window open; to show the files to the user, open the window with desktop.open_app app=files.

## Read a text file
slug: read-a-text-file
summary: Read the text content of a file in the Files area.
keywords: read, show, open, contents, look at
tools: files.read

When: the user asks to read, show or look at the contents of a text file.
Steps:
1. call_tool tool=files.read path=/notes/todo.txt
Check: the result has the file's text and says whether it was cut off.
Gotchas: change path=; for a long file pass max_chars to read just the first part.

## Write a new note
slug: write-a-new-note
summary: Save a brand new text file with the given content.
keywords: write, save, create, new note, new file
tools: files.write

When: the user asks to write, save or create a new note or text file.
Steps:
1. call_tool tool=files.write path=/notes/todo.txt text=Buy milk
Check: files.info on the new path shows the file and its size.
Gotchas: change path= and text=; if the name is taken the error names files.overwrite to replace it instead.

## Change an existing file
slug: change-an-existing-file
summary: Update the content of a file by reading it, then overwriting it.
keywords: change, edit, update, fix, modify
tools: files.read, files.overwrite

When: the user wants a file's content changed; the file already exists.
Steps:
1. call_tool tool=files.read path=/notes/todo.txt
2. call_tool tool=files.overwrite path=/notes/todo.txt text=Buy milk\nCall Ana
Check: files.read on the path shows the new content.
Gotchas: the user should agree before step 2, since it replaces the whole file; read it first so nothing is lost.

## Add a line to a file
slug: add-a-line-to-a-file
summary: Append text to the end of a file without touching the rest.
keywords: append, add, extend, line, add to
tools: files.append

When: the user asks to add a line or more text to the end of a file.
Steps:
1. call_tool tool=files.append path=/notes/todo.txt text=\nCall Ana
Check: files.read on the path shows the new text at the end.
Gotchas: change path= and text=; the existing content is kept, the text is only added at the end.

## Make a folder
slug: make-a-folder
summary: Create a new folder in the Files area, with any missing parents.
keywords: folder, directory, make, create, new folder
tools: files.mkdir

When: the user asks to make, create or add a new folder.
Steps:
1. call_tool tool=files.mkdir path=/notes/2026
Check: files.list on the parent folder shows the new folder.
Gotchas: change path=; missing parent folders are created too.

## Rename or move a file
slug: rename-or-move-a-file
summary: Give a file a new name, or move it to another folder.
keywords: rename, move, new name, relocate, change name
tools: files.rename

When: the user asks to rename a file, or move it to another folder.
Steps:
1. call_tool tool=files.rename path=/notes/todo.txt to=/notes/todo-2026.txt
Check: files.list shows the file under its new name and the old one is gone.
Gotchas: change path= and to=; a different folder in to= moves the file; if the new name is taken, the error suggests a free name with (2) in it.

## Delete a file
slug: delete-a-file
summary: Delete a file, or an empty folder, from the Files area.
keywords: delete, trash, remove, get rid of, wipe
tools: files.delete

When: the user asks to delete, trash or remove a file or folder.
Steps:
1. call_tool tool=files.delete path=/notes/old.txt
Check: files.list on the folder no longer shows the file.
Gotchas: tell the user what will be deleted before calling; for a non-empty folder pass recursive=true, which also deletes its contents.

## Find a file by name
slug: find-a-file-by-name
summary: Search the Files area for files whose name contains a word.
keywords: find, search, look for, where is, locate
tools: files.find

When: the user asks to find or search for a file by part of its name.
Steps:
1. call_tool tool=files.find query=todo
Check: the result lists the paths whose names contain the searched part.
Gotchas: change query=; add under= to search only one folder. files.find works without the Files window open; to show the files to the user, open the window with desktop.open_app app=files.

## Tidy files into a folder
slug: tidy-files-into-a-folder
summary: Make a folder and move several loose files into it.
keywords: tidy, organize, sort, clean up, files into
tools: files.mkdir, files.rename

When: the user wants loose files gathered into one folder.
Steps:
1. call_tool tool=files.mkdir path=/notes/2026
2. call_tool tool=files.rename path=/notes/todo.txt to=/notes/2026/todo.txt
3. call_tool tool=files.rename path=/notes/ideas.md to=/notes/2026/ideas.md
Check: files.list on /notes/2026 shows the moved files and the old names are gone.
Gotchas: repeat the rename with each file to move; list the folder first with files.list to see what is there; move only the files the user named or that match their pattern, and leave the rest where they are.

## Copy a file
slug: copy-a-file
summary: Make a second copy of a file somewhere else by reading it, then writing it.
keywords: copy, duplicate, clone, second copy, copy to
tools: files.read, files.write

When: the user wants a copy of a file in another place, with the original kept.
Steps:
1. call_tool tool=files.read path=/notes/todo.txt
2. call_tool tool=files.write path=/archive/todo-copy.txt text=Buy milk
Check: files.info shows both files with the same size.
Gotchas: put the content from step 1 into text= in step 2; if the copy name is taken, the error names files.overwrite.

## Check how big a file is
slug: check-how-big-a-file-is
summary: Show the size and kind of a file or folder.
keywords: size, how big, bytes, big, file size
tools: files.info

When: the user asks how big a file is, or what a path holds.
Steps:
1. call_tool tool=files.info path=/notes/todo.txt
Check: the result shows the size and whether the path is a file or a folder.
Gotchas: change path= to the file or folder to measure.
