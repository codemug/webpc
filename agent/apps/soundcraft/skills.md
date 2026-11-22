## Open a file from Files
slug: open-a-file-from-files
summary: Open audio, MIDI or a session that is stored in Files in SoundCraft.
keywords: open, load, from files, audio, midi, session, scraftz, import
tools: desktop.open_app, soundcraft.open_file

When: the user wants to open audio, MIDI or a SoundCraft session that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=soundcraft
2. call_tool tool=soundcraft.open_file path=/SoundCraft/session.scraftz
Check: soundcraft.status shows the wrapper opened the file; the session or audio appears in the editor.
Gotchas: change path= to the Files path of an audio, MIDI or .scraftz session file; SoundCraft stays silent until the wrapper's Enable audio button is clicked.

## Save a copy of the session to Files
slug: save-a-session-copy-to-files
summary: Save a copy of the SoundCraft session as a .scraftz bundle in Files.
keywords: save, copy, to files, session, scraftz, export, keep, write
tools: desktop.open_app, soundcraft.save_copy

When: the user wants to keep a copy of the SoundCraft session in Files.
Steps:
1. call_tool tool=desktop.open_app app=soundcraft
2. call_tool tool=soundcraft.save_copy path=/SoundCraft/session.scraftz
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: the tool waits for the user to save in the editor (Save Session, the .scraftz bundle); a plain .scraft save is not captured, so use the .scraftz bundle; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive).

## Arrange audio in the editor
slug: arrange-audio-in-the-editor
summary: SoundCraft arranges audio and MIDI on its native timeline; the agent opens the app and the user works the editor.
keywords: arrange, audio, midi, mix, session, timeline, transport, edit
tools: desktop.open_app, soundcraft.status

When: the user wants to arrange, edit or mix audio in SoundCraft.
Steps:
1. call_tool tool=desktop.open_app app=soundcraft
Check: the editor is open and showing the timeline; the user drives the native transport and mixer directly.
Gotchas: the agent has no SoundCraft editing tools, so it opens the app and the user works the editor; soundcraft.status shows the wrapper status line; audio starts only after the wrapper's Enable audio button.
