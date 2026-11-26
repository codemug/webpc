## Encode text in Base64
slug: base64-encode
summary: Turn plain text into its Base64 encoding with a single CyberChef operation.
keywords: base64, encode, base 64, b64, to base64, convert to, morse, from morse
tools: desktop.open_app, cyberchef.bake

When: the user wants to Base64-encode some text.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=To_Base64 input=zebra house
Check: the result output is the Base64 string and type says string.
Gotchas: change input=; underscores in recipe become spaces, so To_Base64 means the "To Base64" operation; the result also shows up in CyberChef's output pane; for Morse the direction is in the name: To Morse Code encodes and From Morse Code decodes (likewise To/From Base64 and To/From Hex).

## Decode text from Base64
slug: base64-decode
summary: Turn a Base64 string back into the text it encodes.
keywords: base64, decode, from base64, b64 decode, convert back, dode
tools: desktop.open_app, cyberchef.bake

When: the user has a Base64 string and wants the original text.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=From_Base64 input=emVidmEgaG91c2U=
Check: the result output is the decoded text; ask the user to confirm it looks right if it is binary.
Gotchas: change input=; if the input is not valid Base64 the bake fails and the error message is returned; input= is the text itself, not a file path - read a file with files.read first and pass its text as input= (and save the decoded text with files.write text=, again the text, not a path).

## Encode text in Hex
slug: hex-encode
summary: Turn plain text into its hexadecimal representation.
keywords: hex, hexadecimal, encode hex, to hex, byte dump
tools: desktop.open_app, cyberchef.bake

When: the user wants to see the hex (byte) form of some text.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=To_Hex input=zebra
Check: the result output is the hex string, two characters per byte.
Gotchas: change input=; use the From_Hex operation to go the other way; hex is one byte per two characters.

## Run a multi-step pipeline
slug: multi-step-pipeline
summary: Chain several CyberChef operations, each reading the previous output.
keywords: pipeline, chain, sequence, multiple, then, decode and, hex, encode, base64, sha256, digest, checksum, first, after that
tools: desktop.open_app, cyberchef.bake

When: the user wants several transformations applied in order.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=From_Hex,To_Upper_case input=7a65627261
Check: the result output is the final step's output (here ZEBRA) and ops lists the operations run.
Gotchas: change recipe= and input=; the whole pipeline is ONE bake with the comma recipe (e.g. From Hex,To Upper case,To Base64) - do not bake the steps separately, and never type out a later step's result yourself, only a bake result is a result; operations run left to right, comma-separated, and one input= feeds the first operation only - every following operation reads the previous one's output, so a later step never re-reads the original input (to base64-encode an MD5, the recipe is MD5,To_Base64 with one input=); every name must be a real operation; an operation can carry its own settings in the recipe, e.g. recipe=ROT13(Amount=23) for a non-default shift.

## Hash the text
slug: hash-text
summary: Compute a digest (MD5 by default) of the input text.
keywords: hash, digest, md5, checksum, fingerprint, signature, sha256, sha-256, sha224, sha384, sha512
tools: desktop.open_app, cyberchef.bake

When: the user wants a hash or digest of some text.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=MD5 input=zebra house
Check: the result output is the hash digest in hex.
Gotchas: change input= and recipe=; MD5 is shown as the example; SHA-256 is recipe=SHA256 (likewise SHA224, SHA384, SHA512 - the SHA-2 aliases bake the SHA2 operation at that size, verified live), while MD5 and SHA1 are their own operations; use cyberchef.list_operations for the other hash operations (SHA, CRC).

## Shift the letters (ROT13, Caesar cipher)
slug: shift-the-letters
summary: Shift every letter by a fixed number of places with ROT13 (the app's only shift operation) and verify by shifting back.
keywords: rot13, rot 13, caesar, caesar cipher, caesar shift, shift letters, rotate letters, letter shift, shift, verify shift
tools: desktop.open_app, cyberchef.bake

When: the user wants letters shifted with ROT13 or a Caesar cipher, or wants to verify a shift by reversing it.
Steps:
1. call_tool tool=desktop.open_app app=cyberchef
2. call_tool tool=cyberchef.bake recipe=ROT13 input=Uvfg uvag
3. call_tool tool=cyberchef.bake recipe=ROT13 input=This that
Check: the second call's output is the shifted text, and the third call (the shifted text as input) gives the original back.
Gotchas: the app has no Caesar operation - a Caesar shift is baked as ROT13 with an Amount, and Amount is the forward rotation (a decode of a shift-3 text is recipe=ROT13(Amount=23), because 26-3=23); the default ROT13 with no Amount shifts 13 and is its own reverse, so the verify step uses the same recipe; never bake the "Caesar Box Cipher" operation for this - it is a different grid cipher and bakes nulls on plain words; change input= and copy the user's text exactly, character for character.

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
Gotchas: change query= or drop it to list more; the query is a case-insensitive substring of the name, so base64, To_Base64 and To Upper case all find "To Base64"; the list is capped at the top 10 matches.
