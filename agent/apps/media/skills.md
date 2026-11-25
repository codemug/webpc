## Play a file
slug: play-a-file
summary: Play an audio or video file from the Files app in the Media Player.
keywords: play, open, listen, watch, audio, video, song, file
tools: desktop.open_app, media.play_file

When: the user wants to play, open or listen to an audio or video file.
Steps:
1. call_tool tool=desktop.open_app app=media
2. call_tool tool=media.play_file path=/music/tune.mp3
Check: the result has the file name and says whether it is playing.
Gotchas: change path= to the full Files path - the file's real location, not a guess (a tone file saved in the music folder is /music/bell.wav, not /tmp/bell.wav; a wrong path is an error that points at files.find); only audio and video files are accepted; if playing is false with a note, autoplay was blocked by the browser, so tell the user to click Play in the Media app.

## Pause the playback
slug: pause-the-playback
summary: Pause the audio or video that is playing.
keywords: pause, stop, hold, quiet, halt
tools: desktop.open_app, media.pause

When: the user wants the current playback to stop for a while.
Steps:
1. call_tool tool=desktop.open_app app=media
2. call_tool tool=media.pause
Check: media.status shows playing is false.
Gotchas: pausing keeps the position, so the same file continues from where it stopped; use it instead of stopping the whole app.

## Move the playback position
slug: move-the-playback-position
summary: Jump to a given second of the current media.
keywords: seek, jump, skip to, position, fast forward, rewind, second
tools: desktop.open_app, media.seek

When: the user wants to jump forward or back in the current media.
Steps:
1. call_tool tool=desktop.open_app app=media
2. call_tool tool=media.status
3. call_tool tool=media.seek seconds=30
Check: the result reports the new time.
Gotchas: change seconds=; the media must be loaded first (check media.status duration), and seconds must stay within the media length.

## Change the volume
slug: change-the-volume
summary: Set the Media Player volume from 0 to 100 percent.
keywords: volume, louder, quieter, mute, sound level, percent
tools: desktop.open_app, media.volume

When: the user wants the playback louder or softer.
Steps:
1. call_tool tool=desktop.open_app app=media
2. call_tool tool=media.volume percent=35
Check: the result reports the new volume.
Gotchas: change percent=; the value is a percent from 0 to 100 and is saved by the app; for full silence use percent=0, the separate Mute button toggles muting.

## Check what is playing
slug: check-what-is-playing
summary: Report the current title, position, volume and the playlist.
keywords: status, playing, now, current, what, playlist, track
tools: desktop.open_app, media.status

When: the user asks what is playing, or before controlling playback.
Steps:
1. call_tool tool=desktop.open_app app=media
2. call_tool tool=media.status
Check: the result has the title, the playing flag, the position and the playlist.
Gotchas: a null duration means nothing is loaded yet; the playlist lists every item with its current flag.
