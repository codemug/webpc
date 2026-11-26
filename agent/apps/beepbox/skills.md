## Get the song link
slug: get-the-song-link
summary: Get the current BeepBox song hash (its share URL) and tempo.
keywords: song link, share, hash, copy, tempo, bpm, song data
tools: desktop.open_app, beepbox.get_song

When: the user asks for the song link, or before loading a different song.
Steps:
1. call_tool tool=desktop.open_app app=beepbox
2. call_tool tool=beepbox.get_song
Check: the result has the hash (the part after # in a share URL) and the tempo in BPM.
Gotchas: the hash is the live song, so it is fresh after any edit; give the hash to the user as the part after # in a BeepBox URL.

## Load a song from a link
slug: load-a-song-from-a-link
summary: Open a BeepBox song from a share URL or a bare hash.
keywords: load, open, import, paste link, song url, share url, song
tools: desktop.open_app, beepbox.load_song

When: the user has a BeepBox song link or hash and wants it opened.
Steps:
1. call_tool tool=desktop.open_app app=beepbox
2. call_tool tool=beepbox.load_song hash=sJ3mR8k2q
Check: beepbox.get_song returns the same hash.
Gotchas: change hash=; a full URL is fine, the part after # is what matters; loading replaces the current song in the editor.

## Start a new song
slug: start-a-new-song
summary: Clear the editor to a blank song; the current song is lost unless its hash was saved.
keywords: new song, blank, fresh, start over, clear, reset
tools: desktop.open_app, beepbox.new_song

When: the user wants a fresh BeepBox song and agreed to lose the current one.
Steps:
1. call_tool tool=desktop.open_app app=beepbox
2. call_tool tool=beepbox.get_song
3. call_tool tool=beepbox.new_song
Check: beepbox.get_song returns a different hash (the blank song).
Gotchas: call get_song first and keep the old hash in the reply so the user can get the previous song back; this tool cannot undo.

## Change the tempo
slug: change-the-tempo
summary: Set the song tempo in beats per minute.
keywords: tempo, bpm, speed up, slow down, faster, slower, beats per minute
tools: desktop.open_app, beepbox.set_tempo

When: the user wants the song played faster or slower.
Steps:
1. call_tool tool=desktop.open_app app=beepbox
2. call_tool tool=beepbox.set_tempo bpm=180
Check: the result reports the new tempo and beepbox.get_song agrees.
Gotchas: change bpm=; the app allows 30 to 300 BPM; tempo affects playback speed, not the notes.

## Play the song
slug: play-the-song
summary: Play the current song from the start position.
keywords: play, listen, hear, start playback, audition, sound, song
tools: desktop.open_app, beepbox.play

When: the user wants to hear the song.
Steps:
1. call_tool tool=desktop.open_app app=beepbox
2. call_tool tool=beepbox.play
Check: the result says playing is true.
Gotchas: if the app muted the audio (the WebPC audio guard), tell the user to check the speaker in the BeepBox window; playing can be stopped with beepbox.stop.

## Stop the song
slug: stop-the-song
summary: Stop the song that is playing.
keywords: stop, pause, halt, quiet, silence, end playback, song
tools: desktop.open_app, beepbox.stop

When: the user wants playback to stop.
Steps:
1. call_tool tool=desktop.open_app app=beepbox
2. call_tool tool=beepbox.stop
Check: the result says playing is false.
Gotchas: stopping is a no-op with a clear result when nothing is playing; the song position is kept for the next play.
