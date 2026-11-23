## Open a capture
slug: open-a-capture
summary: Open a pcap or pcapng capture file from the Files app in the Packet Viewer.
keywords: open capture, pcap, pcapng, packet capture, import, inspect traffic
tools: desktop.open_app, packets.open_capture

When: the user has a network capture file and wants to look inside it.
Steps:
1. call_tool tool=desktop.open_app app=packets
2. call_tool tool=packets.open_capture path=/captures/web.pcapng
Check: the result has a summary line with the packet count, the file type and the elapsed time.
Gotchas: change path=; the Wireshark engine (about 21 MB) loads on first use, so the first open of a session can take a while; the format is detected from the file's magic bytes, not its extension; a non-capture file is rejected with the app's error.

## Filter the packets
slug: filter-the-packets
summary: Apply a display filter so the table lists only matching packets.
keywords: filter, display filter, show only, narrow, tcp port, packet expression
tools: desktop.open_app, packets.filter

When: the user wants only certain packets, for example one port or one host.
Steps:
1. call_tool tool=desktop.open_app app=packets
2. call_tool tool=packets.filter expr=tcp.port == 443
Check: the result reports how many packets match the filter.
Gotchas: change expr=; an empty or omitted expr clears the filter and lists everything; a rejected filter is an error carrying the engine's message; the app renders at most the first 1000 matching rows.

## List the packets
slug: list-the-packets
summary: List the visible packet rows with one value per column.
keywords: list packets, table, rows, frames, packet list, show all
tools: desktop.open_app, packets.list

When: the user wants to see the packets, or before picking one to inspect.
Steps:
1. call_tool tool=desktop.open_app app=packets
2. call_tool tool=packets.list
Check: the result has the column names, the rows and the currently selected frame number.
Gotchas: a capture must be open first; limit= caps the rows (1 to 500, default 50); the selected row is the one whose detail the Packet Viewer shows.

## Inspect one packet
slug: inspect-one-packet
summary: Show one packet's protocol tree and hex dump.
keywords: packet detail, protocol tree, hex dump, inspect frame, dissect, deep dive
tools: desktop.open_app, packets.list, packets.detail

When: the user wants to look inside a specific packet.
Steps:
1. call_tool tool=desktop.open_app app=packets
2. call_tool tool=packets.list
3. call_tool tool=packets.detail number=1
Check: the result has the protocol tree (one line per layer) and the hex dump.
Gotchas: change number= to a frame number from packets.list; a frame not in the current view is rejected (adjust the filter or raise the list limit); a long hex dump is truncated and hexTruncated is true.

## Summarize a capture
slug: summarize-a-capture
summary: Open a capture and report what is in it: size, traffic and a sample packet.
keywords: summarize, overview, what is in, analyze capture, review, quick look
tools: desktop.open_app, packets.open_capture, packets.list, packets.detail

When: the user wants a quick picture of a capture without choosing the tools.
Steps:
1. call_tool tool=desktop.open_app app=packets
2. call_tool tool=packets.open_capture path=/captures/web.pcapng
3. call_tool tool=packets.list limit=20
4. call_tool tool=packets.detail number=1
Check: the reply covers the summary line, the packet rows and at least one packet's protocol tree.
Gotchas: keep the detail call to one or two packets so the reply stays short; quote the numbers from the tool results, not from memory; a large capture may show only its first rows.
