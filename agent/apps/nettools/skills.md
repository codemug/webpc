## Look up a DNS record
slug: look-up-a-dns-record
summary: Look up a DNS record (A, AAAA, MX, TXT, NS, PTR) over HTTPS via Cloudflare or Google.
keywords: dns, resolve, a record, mx, txt, pointer, reverse lookup, doh
tools: desktop.open_app, nettools.dns_lookup

When: the user wants to resolve a domain or check what a DNS record points to.
Steps:
1. call_tool tool=desktop.open_app app=nettools
2. call_tool tool=nettools.dns_lookup name=example.com type=A
Check: the result names the provider and the status (for example NOERROR) plus the answers.
Gotchas: change name= and type=; for PTR enter an IP address (the reverse name is built by the app); the lookup goes to an external DNS-over-HTTPS service, so it needs the network.

## Fetch a domain or IP record
slug: fetch-a-domain-or-ip-record
summary: Fetch the RDAP registration record (nameservers, dates, status) for a domain or IP.
keywords: rdap, whois, registration, nameservers, registrar, registry record
tools: desktop.open_app, nettools.rdap

When: the user asks who registered a domain, or for the registration data of a domain or IP.
Steps:
1. call_tool tool=desktop.open_app app=nettools
2. call_tool tool=nettools.rdap query=example.com
Check: the result has the nameservers, the status and the dates, when the registry reports them.
Gotchas: change query= (a domain or an IP address); rdap.org redirects to the responsible registry, so the answer names that registry; this is registry data, not the current DNS records.

## Calculate a subnet
slug: calculate-a-subnet
summary: Compute the network, mask, host range and address count of a CIDR block.
keywords: subnet, cidr, network, mask, ip range, hosts in, broadcast
tools: desktop.open_app, nettools.subnet

When: the user asks about a CIDR block, an IP range or how many addresses a prefix has.
Steps:
1. call_tool tool=desktop.open_app app=nettools
2. call_tool tool=nettools.subnet cidr=10.0.0.0/24
Check: the result has the network, the mask and the address count (plus the first and last host for IPv4).
Gotchas: change cidr= to the block in <address>/<prefix> form, IPv4 or IPv6; this runs fully locally, so it never sends a request.

## Check a password strength
slug: check-a-password-strength
summary: Check how strong a password is, with a score and crack-time estimates.
keywords: password, strength, crack, zxcvbn, score, guessable
tools: desktop.open_app, nettools.password_strength

When: the user wants a password rated, or wants to know if one is weak.
Steps:
1. call_tool tool=desktop.open_app app=nettools
2. call_tool tool=nettools.password_strength text=correct-horse-battery-staple
Check: the result has the score out of 4 and the offline and online attack estimates.
Gotchas: change text= to the exact password string the user named - if the user says "my old password is falcon", the password is falcon (not the words "old password"); score each of the user's passwords with its own call; the check is fully local (the password is not stored, logged or sent); if the user pastes a real password into the chat, tell them it now sits in the conversation.

## Encrypt a file with age
slug: encrypt-a-file-with-age
summary: Encrypt a file from the Files app with an age passphrase; the result downloads.
keywords: age, encrypt, encrypt file, passphrase, secure file, age encryption
tools: desktop.open_app, nettools.age_encrypt

When: the user wants a file encrypted with an age passphrase before sending or storing it.
Steps:
1. call_tool tool=desktop.open_app app=nettools
2. call_tool tool=nettools.age_encrypt path=/docs/report.pdf passphrase=s3cret-passphrase
Check: the result says the file was encrypted and that the .age file was downloaded.
Gotchas: change path= and passphrase=; the file is fully read into memory, so keep it a reasonable size; the download lands in the user's downloads folder as <name>.age; encryption is fully local, nothing is uploaded.

## Decrypt an age file
slug: decrypt-an-age-file
summary: Decrypt an age file from the Files app with a passphrase; the result downloads.
keywords: age, decrypt, age file, passphrase, open encrypted file
tools: desktop.open_app, nettools.age_decrypt

When: the user has an .age file and the passphrase and wants it decrypted.
Steps:
1. call_tool tool=desktop.open_app app=nettools
2. call_tool tool=nettools.age_decrypt path=/docs/report.pdf.age passphrase=s3cret-passphrase
Check: the result says the file was decrypted and that it was downloaded under its original name.
Gotchas: change path= and passphrase=; a wrong passphrase is reported as a decryption failure, not a crash; decryption is fully local and the result downloads to the user's downloads folder.
