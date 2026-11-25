# Journey fixtures

Small real files that journey setup copies into the Files store (`seed_fixture: { path, fixture }`). Ask the lead for a new one rather than seeding placeholder text as a binary file.

| Fixture | What it is | Facts a check can pin |
|---|---|---|
| `beach-sunset.jpg` | JPEG photo, 320 x 213, orange to blue gradient, a dark square | landscape; width 320, height 213 |
| `mountain-portrait.jpg` | JPEG photo, 213 x 320, sky blue to green gradient | portrait; width 213, height 320 |
| `city-night.png` | PNG, 240 x 160, dark blue to brown gradient | width 240, height 160 |
| `tone-440hz-2s.wav` | WAV, mono, 16 kHz, 16-bit, a 440 Hz tone for 2.0 s | duration 2 s, 32,000 samples |
| `sales-q3.csv` | 8 sales rows: Date, Region, Product, Units, Unit price (July to September 2026) | 100 units in total; North 23 units; Widget 64 units |
| `report-q3.pdf` | 2 pages with real text (Helvetica) | page 1: "Quarterly report Q3 2026", "Revenue grew 14 percent over Q2.", "The North region led with 41 orders."; page 2: "Appendix", "Returns fell to 2.1 percent.", "Next review: 15 January 2027." |
| `web-sample.pcap` | Classic pcap (Ethernet, 232 bytes), 4 frames on 192.168.1.x | frame 1 ICMP echo request 192.168.1.10 → 192.168.1.1; frame 2 ICMP echo reply back; frame 3 TCP SYN 192.168.1.10:52344 → 192.168.1.1:443; frame 4 ARP request who-has 192.168.1.1 tell 192.168.1.10. Filters: icmp → 2, tcp → 1, tcp.port == 443 → 1, arp → 1 |

Regenerate with the lead's scripts in `.lanes/scratch/journeys/` (`make_fixtures.py`, `make_text_pdf.py`).

## `web-sample.pcap` (classic pcap)

Hand-built with a one-off Node script (24-byte global header, linktype 1/Ethernet, one 16-byte
record header per frame; protocol fields big-endian, correct IP/ICMP/TCP checksums). The four
frames above are the whole capture; tcpdump reads it cleanly and the dissection engine is
Wireshark 4.6 via wiregasm, so journey checks pin Wireshark's protocol tree labels
("Internet Control Message Protocol", "Transmission Control Protocol", "Address Resolution
Protocol") and display-filter match counts.

## `shop.db` (SQLite 3)

Built to the spec in the header of `journeys/sqliteviz.yaml`. Tables `customers (id, name)`, `products (id, name, price)`, `orders (id, customer_id, product_id, amount)`. Facts a check can pin: 42 customers, 8 products, 156 orders; total amount 15600.00, average 100.00; Ana (id 7) has the most orders, 12 (next is Ben with 11); orders per product Widget 64, Gadget 41, Gizmo 31, Sprocket 20; Cog, Bolt, Nut and Bearing have none (so 4 products have orders and 4 do not); Widget price 4.50 (10 percent more is 4.95). Regenerate with `make_shop_db.py` in the lead's scratch folder (it asserts every fact above).
