## Open the demo project
slug: open-a-demo-project
summary: Open the built-in demo project with sample media.
keywords: demo, sample, start, example, project, show me
tools: desktop.open_app, filmcraft.open_demo, filmcraft.inspect

When: the user wants to see FilmCraft working with media.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.open_demo
Check: filmcraft.inspect lists the demo bins and the active sequence.
Gotchas: opening the demo replaces the open project (unsaved edits are lost).

## Look at the project and the timeline
slug: look-at-the-project
summary: Inspect the bins, the media and what is on the timeline.
keywords: inspect, timeline, bins, clips, media, what is in
tools: desktop.open_app, filmcraft.inspect, filmcraft.sequence_inspect

When: the user asks what is in the project or on the timeline.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.inspect
3. call_tool tool=filmcraft.sequence_inspect
Check: the project tree lists bins with item ids and the sequence lists tracks and clips.
Gotchas: item ids and clip ids in the reply are what filmcraft.place, filmcraft.move and filmcraft.apply_effect take.

## Move the playhead
slug: move-the-playhead
summary: Put the playhead at a second, frame or timecode.
keywords: playhead, seek, jump, scrub, time, go to
tools: desktop.open_app, filmcraft.playhead, filmcraft.sequence_inspect

When: the user wants the playhead at a specific time.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.playhead seconds=3.5
Check: filmcraft.sequence_inspect shows the playhead at the new time.
Gotchas: frame= and timecode= are alternatives to seconds=; filmcraft.undo takes the playhead back.

## Cut a clip at the playhead
slug: cut-at-the-playhead
summary: Razor-cut a track or one clip at the playhead or a time.
keywords: razor, cut, split, slice, trim point, cut at
tools: desktop.open_app, filmcraft.playhead, filmcraft.razor

When: the user wants a cut at the playhead or at a given time.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.playhead seconds=4
3. call_tool tool=filmcraft.razor track=V1
Check: the reply says how many cuts were made; filmcraft.sequence_inspect lists the new clips.
Gotchas: clip= cuts one clip instead of whole tracks; the cut time is the playhead when seconds=, frame= and timecode= are all omitted.

## Put media on the timeline
slug: put-media-on-the-timeline
summary: Place a project item onto a video or audio track at a time.
keywords: place, insert, add clip, media, bin, timeline, drop
tools: desktop.open_app, filmcraft.project_inspect, filmcraft.place

When: the user wants a clip from the bins onto the timeline.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.project_inspect
3. call_tool tool=filmcraft.place item=3 track=V1 seconds=5
Check: filmcraft.sequence_inspect lists the new clip on the track at the right start.
Gotchas: track=new or audioTrack=new adds a track; source_in= and duration= skip and limit media; video=false or audio=false places only one stream.

## Rearrange clips on the timeline
slug: rearrange-clips
summary: Move clips to new track and time positions.
keywords: move, drag, rearrange, reorder, track, reposition
tools: desktop.open_app, filmcraft.move, filmcraft.sequence_inspect

When: the user wants clips moved around on the timeline.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.move moves=[{"clip":5,"track":"V2","seconds":10}]
Check: filmcraft.sequence_inspect shows the clip on its new track at the new time.
Gotchas: track=new moves a clip to a new track; copy=true moves copies and keeps the originals; linked=true brings linked sound and picture along.

## Apply an effect to a clip
slug: apply-an-effect
summary: List the effects, then apply one to the selected clips.
keywords: effect, blur, color, grade, transition, apply, filter
tools: desktop.open_app, filmcraft.apply_effect, filmcraft.sequence_inspect

When: the user wants an effect on a clip, or the list of effects.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.apply_effect
3. call_tool tool=filmcraft.apply_effect effect=Gaussian Blur
Check: filmcraft.sequence_inspect lists the effect on the clip.
Gotchas: step 2 returns the catalogue (kind= narrows it to Video, Audio or a transition kind); effect= takes an id or a display name; clips= names the clips, the selection when omitted.

## Find and run any command
slug: run-any-editing-command
summary: Look up a FilmCraft command by name, then run it with parameters.
keywords: command, run, menu, what can it do, markers, history
tools: desktop.open_app, filmcraft.list_commands, filmcraft.run_command

When: the user wants an action that has no dedicated tool.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.list_commands query=marker
3. call_tool tool=filmcraft.run_command command=playhead.set params=seconds=2
Check: filmcraft.sequence_inspect shows the action took effect.
Gotchas: run_command takes key=value lines in params= (a [ ... ] or { ... } value is JSON); file.newProject, project.delete, sequence.lift and the markers.clear ids are destructive (they replace or delete project data).
## Open a project or media from Files
slug: open-a-project-from-files
summary: Open a .fcproj project or import media that is stored in Files.
keywords: open, load, from files, fcproj, project, import, media
tools: desktop.open_app, filmcraft.open_file

When: the user wants to open a project or import media that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.open_file path=/FilmCraft/talk.fcproj
Check: the result has an opened field confirming the load; filmcraft.inspect shows the open project.
Gotchas: change path= to a .fcproj project or media (video, audio, image); opening a project replaces the open one (unsaved work is lost).

## Save a copy of the project to Files
slug: save-a-project-copy-to-files
summary: Save the active FilmCraft project as a .fcproj file in Files.
keywords: save, copy, to files, fcproj, export, keep, write
tools: desktop.open_app, filmcraft.save_copy

When: the user wants to keep a copy of the active project in Files.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.save_copy path=/FilmCraft/talk.fcproj
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; FilmCraft saves .fcproj files, so a target with another extension is refused with the .fcproj path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive); a fresh project with no saved path yet makes the app refuse the save.
