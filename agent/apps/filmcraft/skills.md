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
2. call_tool tool=filmcraft.playhead seconds=2.5
3. call_tool tool=filmcraft.razor track=V1
Check: the reply says how many cuts were made; filmcraft.sequence_inspect lists the new clips.
Gotchas: clip= cuts one clip instead of whole tracks; the cut time is the playhead when seconds=, frame= and timecode= are all omitted.

## Set the in and out marks
slug: set-in-and-out-marks
summary: Set the sequence in and out marks at two times without cutting.
keywords: in mark, out mark, mark in, mark out, in point, out point, in/out, marks, region
tools: desktop.open_app, filmcraft.playhead, filmcraft.run_command, filmcraft.sequence_inspect

When: the user wants an in mark and an out mark on the sequence, with nothing cut.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.playhead seconds=6
3. call_tool tool=filmcraft.run_command command=markers.markIn
4. call_tool tool=filmcraft.playhead seconds=7
5. call_tool tool=filmcraft.run_command command=markers.markOut
Check: filmcraft.sequence_inspect shows in and out at the requested times and the clip keeps its full duration - nothing is cut.
Gotchas: marks are not cuts - filmcraft.razor and filmcraft.add_edit cut the timeline (the reply says cuts=N); the in and out marks are the sequence's in and out fields, separate from the sequence markers (markers.add). Check filmcraft.list_commands query=mark when the marks command takes a time param; a mark on an empty sequence lands nowhere, so place the media first.

## Put media on the timeline
slug: put-media-on-the-timeline
summary: Place a project item onto a video or audio track at a time.
keywords: place, insert, add clip, media, bin, timeline, drop, sequence
tools: desktop.open_app, filmcraft.project_inspect, filmcraft.new_sequence, filmcraft.place

When: the user wants a clip from the bins onto the timeline.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.project_inspect
3. call_tool tool=filmcraft.place item=3 track=V1 seconds=8
Check: filmcraft.sequence_inspect lists the new clip on the track at the right start.
Gotchas: a fresh new_project has no open sequence, so place returns "no sequence is open" - call filmcraft.new_sequence first, then place. item= takes the project item id from project_inspect, or the item name or its Files path - never the whole call as one argument. track= and audioTrack= use the names V1, V2, A1, A2 - not the display names "Video 1"/"Audio 1" that sequence_inspect shows, and not the track ids. track=new or audioTrack=new adds a track; source_in= and duration= skip and limit media; video=false or audio=false places only one stream.

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
3. call_tool tool=filmcraft.run_command command=playhead.set params=seconds=6
Check: filmcraft.sequence_inspect shows the action took effect.
Gotchas: run_command takes key=value lines in params= (a [ ... ] or { ... } value is JSON); file.newProject, project.delete, sequence.lift and the markers.clear ids are destructive (they replace or delete project data).
## Open a project or media from Files
slug: open-a-project-from-files
summary: Open a .fcproj project or import media (video, audio, still image) that is stored in Files.
keywords: open, load, from files, fcproj, project, import, media, still, still image, photo, image, file
tools: desktop.open_app, filmcraft.open_file

When: the user wants to open a project or import media that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.open_file path=/FilmCraft/talk.fcproj
Check: the result has an opened field confirming the load; filmcraft.inspect shows the open project.
Gotchas: change path= to a .fcproj project or media (video, audio, image); opening a project replaces the open one (unsaved work is lost). lightcraft.import_file puts a photo into the LightCraft library, not the FilmCraft project - getting a file into a FilmCraft project (its bins) is always filmcraft.open_file.

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

## Start a new project and import media
slug: start-a-new-project
summary: Start a fresh FilmCraft project by name and import media from Files into it.
keywords: new, project, start, create, fresh, import, media
tools: desktop.open_app, filmcraft.new_project, filmcraft.new_sequence, filmcraft.open_file, filmcraft.project_inspect

When: the user wants to start a fresh project or put media stored in Files into a new project.
Steps:
1. call_tool tool=desktop.open_app app=filmcraft
2. call_tool tool=filmcraft.new_project name=Showreel
3. call_tool tool=filmcraft.open_file path=/FilmCraft/title-card.jpg
Check: filmcraft.project_inspect shows the project name and the imported media as an item with an id.
Gotchas: new_project needs name= (the name the user asks for) and replaces the open project, so unsaved work is lost; a new project starts with no open sequence, so filmcraft.place fails with "no sequence is open" until filmcraft.new_sequence runs; step 3 is only when importing media - open_file with a video, audio or still path imports it into the current project like a dropped file, with the exact Files path; opening a .fcproj instead replaces the project.
