## Open a project or mesh from Files
slug: open-a-project-from-files
summary: Open a .tcraft project or import a mesh that is stored in Files in TextureCraft.
keywords: open, load, from files, tcraft, import, glb, obj, mesh
tools: desktop.open_app, texturecraft.open_file

When: the user wants to open a TextureCraft project or import a mesh that is stored in Files.
Steps:
1. call_tool tool=desktop.open_app app=texturecraft
2. call_tool tool=texturecraft.open_file path=/TextureCraft/car.tcraft
Check: texturecraft.status shows the wrapper opened the file; the project or mesh appears in the editor.
Gotchas: change path= to a .tcraft project or a mesh (glb, gltf, fbx, dae, obj, stl, ply); images are imported from the editor's own File menu, not through this tool; if the open project reports unsaved changes the wrapper asks first before opening the new file.

## Save a copy of the project to Files
slug: save-a-project-copy-to-files
summary: Save a copy of the TextureCraft project as a .tcraft file in Files.
keywords: save, copy, to files, tcraft, export, keep, write
tools: desktop.open_app, texturecraft.save_copy

When: the user wants to keep a copy of the TextureCraft project in Files.
Steps:
1. call_tool tool=desktop.open_app app=texturecraft
2. call_tool tool=texturecraft.save_copy path=/TextureCraft/car.tcraft
Check: the result has the saved Files path and size; files.info on that path shows the same size.
Gotchas: the tool waits for the user to save in the editor; TextureCraft saves .tcraft projects, so a target with another extension is refused with the .tcraft path as the fix; if the path exists the tool errors, so choose another name or pass overwrite=true (which is destructive).

## Bake and author textures in the editor
slug: bake-and-author-textures-in-the-editor
summary: TextureCraft bakes and authors textures for 3D meshes in its native editor; the agent opens the app and the user works the editor.
keywords: bake, texture, uv, mesh, material, author, 3d, set
tools: desktop.open_app, texturecraft.status

When: the user wants to bake or author textures in TextureCraft.
Steps:
1. call_tool tool=desktop.open_app app=texturecraft
Check: the editor is open and showing the project; the user drives the native baker and painter directly.
Gotchas: the agent has no TextureCraft editing tools, so it opens the app and the user works the editor; texturecraft.status shows the wrapper status line; texture-set and mesh exports download normally and are not saved to Files.
