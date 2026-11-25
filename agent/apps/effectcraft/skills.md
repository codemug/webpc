## Open the demo project
slug: open-a-demo-project
summary: Open the built-in demo project, or start a new empty one.
keywords: demo, new project, start, example, sample, open
tools: desktop.open_app, effectcraft.project_open, effectcraft.inspect

When: the user wants to see EffectCraft working or to start over.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.project_open demo=true
Check: effectcraft.inspect lists the project and the active composition.
Gotchas: opening the demo or a new project replaces the open one (unsaved edits are lost); new=true starts an empty project instead; for a fresh project with a comp and layers, use effectcraft.new_project (the start-a-project-with-text-comp skill) instead of the demo.

## Start a project with a text comp
slug: start-a-project-with-text-comp
summary: Start a new project, create a named composition and add a text layer to it.
keywords: new project, start, composition, comp, text layer, titles, title, pulse, fade, background, solid
tools: desktop.open_app, effectcraft.new_project, effectcraft.new_comp, effectcraft.add_text_layer, effectcraft.comp

When: the user wants a fresh project with a new composition and a text layer to work on.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.new_project
3. call_tool tool=effectcraft.new_comp name=Credits duration=8
4. call_tool tool=effectcraft.add_text_layer text=On schedule
Check: effectcraft.comp shows the comp with the text layer; the layer name follows the text.
Gotchas: step 2 replaces the open project (unsaved work is lost) - never edit the demo or the open project for a fresh-project ask; new_comp makes its comp active, takes width= and height= in pixels and snaps duration to whole frames; a solid background is add_solid name=Backdrop width=1280 height=720, an imported still is open_file then add_item item=<name>; after this, keyframe with keyframe_add or assign an expression with property_set expression=.

## Look at the project and the comps
slug: look-at-the-project
summary: Inspect the project, the comps and the layers of a comp.
keywords: inspect, project, comp, layers, composition, what is in
tools: desktop.open_app, effectcraft.project, effectcraft.comp

When: the user asks what is in the project or what a comp contains.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.project
3. call_tool tool=effectcraft.comp
Check: the project lists comps and items; the comp lists its layers with ids and names.
Gotchas: layer ids and comp names in the replies are what the other tools take as layer= and comp=.

## Read a layer and its properties
slug: read-a-layer
summary: Show a layer tree and read individual property values.
keywords: layer, property, value, opacity, position, transform, read
tools: desktop.open_app, effectcraft.layer, effectcraft.property_get

When: the user asks what a layer has or wants a specific property value.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.layer layer=1
3. call_tool tool=effectcraft.property_get layer=1 path=transform/opacity
Check: the layer tree lists property paths; the reply shows the value at the path.
Gotchas: layer= takes an id, #n (1-based from the top) or a name; path= is match ids joined by / as listed by effectcraft.layer; time= reads the value at a comp time.

## Change a property
slug: change-a-property
summary: Set a property value or expression, or keyframe it at a time.
keywords: set, change, opacity, position, color, scale, rotation, expression
tools: desktop.open_app, effectcraft.property_set, effectcraft.property_get

When: the user wants a property changed, like opacity, position or color.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.property_set layer=1 path=transform/opacity value=40
Check: the reply is the property read back with the new value.
Gotchas: vectors are JSON arrays like value=[960,540]; colors are #rrggbb or [r,g,b,a] 0-1; time= keyframes the value at that time instead of setting it; expression= assigns an expression (empty string removes it).

## Fade a layer in
slug: fade-a-layer-in
summary: Add keyframes that animate a property over time.
keywords: fade, animation, keyframe, tween, motion, over time
tools: desktop.open_app, effectcraft.keyframe_add, effectcraft.property_get

When: the user wants a property animated over time.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.keyframe_add layer=1 path=transform/opacity keys=[{"time":0,"value":0},{"time":8,"value":75}]
Check: effectcraft.property_get shows the keys on the property.
Gotchas: keys= is a JSON array of {time, value?} with time in seconds of layer time; timeBase=comp counts comp time instead; transform paths like transform/scale work the same.

## Blur or grade a layer
slug: add-an-effect
summary: List the effects, then add one to a layer with values.
keywords: effect, blur, glow, color, grade, apply, filter
tools: desktop.open_app, effectcraft.effects_list, effectcraft.effect_add

When: the user wants an effect on a layer, or the list of effects.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.effects_list filter=blur
3. call_tool tool=effectcraft.effect_add layer=1 effect=Gaussian Blur values={"blurriness":8}
Check: the reply lists the effect index, path, name and its parameters.
Gotchas: step 2 returns the registry when the model needs an effect id or name; values= is a JSON object of parameter id to value; the whole add is one undo step, so effectcraft.undo removes it cleanly.

## Build a comp in one step
slug: build-a-comp
summary: Create the comp and its layers with the create tools, or as one batch undo step.
keywords: batch, multi step, one go, atomic, build, create, new comp
tools: desktop.open_app, effectcraft.new_comp, effectcraft.add_text_layer, effectcraft.add_solid, effectcraft.batch

When: the user wants a new comp with its layers ready to work on.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.new_comp name=Credits width=1280 height=720 duration=8
3. call_tool tool=effectcraft.add_text_layer text=On schedule
Check: effectcraft.comp shows the new comp as the active one with its layers.
Gotchas: for a fresh project run effectcraft.new_project first (the create tools edit the open project); each create tool is one undo step - for several edits as ONE undo step use effectcraft.batch with steps= a JSON array of {command, params?}; commands that delete data (track.delete, effect.remove, file.newProject, ...) make a batch destructive. Call new_comp once per comp name: a duplicate name is renamed to "Name 2" and the layers you added stay in the first comp - switch back to it with effectcraft.comp_switch instead of creating it again.

## Find and run any command
slug: run-any-effectcraft-command
summary: Look up an EffectCraft command by name, then run it with parameters.
keywords: command, run, menu, what can it do, time, export
tools: desktop.open_app, effectcraft.list_commands, effectcraft.run_command

When: the user wants an action that has no dedicated tool.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.list_commands query=layer
3. call_tool tool=effectcraft.run_command command=layer.newText params=text=Title
Check: effectcraft.comp or effectcraft.inspect shows the action took effect.
Gotchas: run_command takes key=value lines in params= (a [ ... ] or { ... } value is JSON); command_describe is the registry query command.describe, reachable as run_command command=command.describe; track.delete, edit.purge and file.close are destructive (they delete data or close the project).
## Open a project or media from Files
slug: open-a-project-from-files
summary: Open an .ecproj project or import media that is stored in Files.
keywords: open, load, from files, ecproj, project, import, media
tools: desktop.open_app, effectcraft.open_file

When: the user wants to open a project or import media that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.open_file path=/EffectCraft/ad.ecproj
Check: the result has an opened field confirming the load; effectcraft.project or effectcraft.inspect shows the open project.
Gotchas: change path= to an .ecproj project or media (video, audio, image); opening a project replaces the open one (unsaved work is lost).

## Save a copy of the project to Files
slug: save-a-project-copy-to-files
summary: Save the active EffectCraft project as a .ecproj file in Files.
keywords: save, copy, to files, ecproj, export, keep, write
tools: desktop.open_app, effectcraft.save_copy

When: the user wants to keep a copy of the active project in Files.
Steps:
1. call_tool tool=desktop.open_app app=effectcraft
2. call_tool tool=effectcraft.save_copy path=/EffectCraft/ad.ecproj
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: change path=; EffectCraft saves .ecproj files, so a target with another extension is refused with the .ecproj path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive); a fresh project with no saved path yet makes the app refuse the save.
