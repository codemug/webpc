## Encode text in Base64
slug: base64-encode
summary: Turn plain text into its Base64 encoding with a single CyberChef operation.
keywords: base64, encode, base 64, b64, to base64, convert to
tools: desktop.open_app, cyberchef.bake

When: the user wants to Base64-encode some text.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=To_Base64 input=hello world
Check: the result output is the Base64 string and type says string.
Gotchas: change input=; underscores in recipe become spaces, so To_Base64 means the "To Base64" operation; the result also shows up in CyberChef's output pane.

## Decode text from Base64
slug: base64-decode
summary: Turn a Base64 string back into the text it encodes.
keywords: base64, decode, from base64, b64 decode, convert back
tools: desktop.open_app, cyberchef.bake

When: the user has a Base64 string and wants the original text.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=From_Base64 input=aGVsbG8gd29ybGQ=
Check: the result output is the decoded text; ask the user to confirm it looks right if it is binary.
Gotchas: change input=; if the input is not valid Base64 the bake fails and the error message is returned.

## Encode text in Hex
slug: hex-encode
summary: Turn plain text into its hexadecimal representation.
keywords: hex, hexadecimal, encode hex, to hex, byte dump
tools: desktop.open_app, cyberchef.bake

When: the user wants to see the hex (byte) form of some text.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=To_Hex input=hello
Check: the result output is the hex string, two characters per byte.
Gotchas: change input=; use the From_Hex operation to go the other way; hex is one byte per two characters.

## Run a multi-step pipeline
slug: multi-step-pipeline
summary: Chain several CyberChef operations, each reading the previous output.
keywords: pipeline, chain, sequence, multiple, then, decode and
tools: desktop.open_app, cyberchef.bake

When: the user wants several transformations applied in order.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=From_Hex,To_Upper_case input=48656c6c6f
Check: the result output is the final step's output (here HELLO) and ops lists the operations run.
Gotchas: change recipe= and input=; operations run left to right, comma-separated, so From_Hex,To_Upper_case decodes first then uppercases; every name must be a real operation.

## Hash the text
slug: hash-text
summary: Compute a digest (MD5 by default) of the input text.
keywords: hash, digest, md5, checksum, fingerprint, signature
tools: desktop.open_app, cyberchef.bake

When: the user wants a hash or digest of some text.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=MD5 input=hello world
Check: the result output is the hash digest in hex.
Gotchas: change input= and recipe=; MD5 is shown as the example, use cyberchef.list_operations to find the other hash operations (SHA, CRC) when a different one is wanted.

## Find an operation
slug: find-an-operation
summary: Search the CyberChef operation list by name to learn the right recipe name.
keywords: operation, op, list, find, search, what can, which op
tools: desktop.open_app, cyberchef.list_operations

When: the user is not sure of the exact operation name, or asks what CyberChef can do.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.list_operations query=base64
Check: the result lists matching operations with their names; use a returned name in cyberchef.bake recipe=.
Gotchas: change query= or drop it to list more; names use spaces (To Base64), so in a recipe write them with underscores (To_Base64); the list is capped at the top 10 matches.
