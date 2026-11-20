#!/usr/bin/env python3
"""Local end-to-end test of changes from a mail app (docs/imap-smtp-relay-plan.md §6, phase 4): flags, copy, move,
delete, saving messages and folders, with Python's imaplib and smtplib as the mail app. Needs the `api-relay` dev
server (port 8826), the bridge on 127.0.0.1:1993 and :1465, and the same local test data as imap-test.py. Run from
apps/api:  ORG_ID=… USER_ID=… OWN=… OWN_MAILBOX_ID=… python3 scripts/imap-write-test.py"""
import base64, hashlib, hmac, imaplib, json, os, re, smtplib, ssl, sys, time, urllib.request
from email.message import EmailMessage

API = os.environ.get("API", "http://localhost:8826")
ORG, USER, OWN, BOX = (os.environ[k] for k in ("ORG_ID", "USER_ID", "OWN", "OWN_MAILBOX_ID"))
secret = re.search(r"^JWT_SECRET=(.*)$", open(".dev.vars").read(), re.M).group(1).strip().strip('"')
b64 = lambda v: base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b"=").decode()
def jwt(sub):
    now = int(time.time()); body = f'{b64({"alg":"HS256","typ":"JWT"})}.{b64({"sub":sub,"iat":now,"exp":now+900})}'
    return body + "." + base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
def api(method, path, body=None):
    req = urllib.request.Request(f"{API}/v1{path}", method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {jwt(USER)}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return {"status": e.code, **json.loads(e.read() or b"{}")}
failed = False
def check(name, ok, detail=""):
    global failed; failed |= not ok
    print(f'{"PASS" if ok else "FAIL"}  {name}{"  " + str(detail)[:170] if detail else ""}', flush=True)

ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
pw = api("POST", f"/orgs/{ORG}/app-passwords", {"name": "IMAP write test"}); secret_pw, pw_id = pw["secret"], pw["password"]["id"]
stamp = str(int(time.time()))
def message(subject, mid=None, reply_to=None, body="Body of the test message.\n", size=0):
    m = EmailMessage(); m["From"] = f"Jay Test <{OWN}>"; m["To"] = "ann@outside.test"; m["Subject"] = subject
    m["Message-ID"] = mid or f"<{time.time_ns()}@laptop.local>"; m["Date"] = "Mon, 02 Nov 2026 10:00:00 +0000"
    if reply_to: m["In-Reply-To"] = reply_to
    m.set_content(body)
    if size: m.add_attachment(os.urandom(size), maintype="application", subtype="octet-stream", filename="big.bin")
    return m
def smtp_send(m):
    s = smtplib.SMTP_SSL("127.0.0.1", 1465, context=ctx, timeout=120); s.login(OWN, secret_pw); s.send_message(m); s.quit()
def count(M, folder):
    typ, st = M.status(f'"{folder}"', "(MESSAGES)"); return int(re.search(rb"MESSAGES (\d+)", st[0]).group(1))
def flags(M, uid):
    typ, data = M.uid("FETCH", str(uid), "(FLAGS)"); return data[0].decode() if data and data[0] else ""
def appenduid(resp):
    m = re.search(rb"APPENDUID \d+ (\d+)", resp[0] if resp else b""); return int(m.group(1)) if m else None
def uid_of(M, subject):
    typ, d = M.uid("SEARCH", None, "SUBJECT", f'"{subject}"'); return [int(x) for x in d[0].split()]

M = imaplib.IMAP4_SSL("127.0.0.1", 1993, ssl_context=ctx, timeout=180)
M.login(OWN, secret_pw)
check("UIDPLUS and MOVE are offered after sign-in", all(c in M.capabilities for c in ("UIDPLUS", "MOVE")), M.capabilities)
before = {f: count(M, f) for f in ("Archive", "Trash", "Drafts", "Sent", "INBOX", "Junk")}

# Folders
name = f"Test {stamp}"
check("CREATE makes a folder", M.create(f'"{name}"')[0] == "OK" and any(name.encode() in f for f in M.list()[1]))
check("the same name again is refused", M.create(f'"{name.upper()}"')[0] == "NO")
check("a built-in folder can't be renamed or deleted", M.rename("Sent", '"Sent 2"')[0] == "NO" and M.delete("Trash")[0] == "NO")
renamed = f"Tést {stamp} renamed"
enc = renamed.replace("é", "&AOk-")
check("RENAME works, also with a name outside ASCII", M.rename(f'"{name}"', f'"{enc}"')[0] == "OK" and any(enc.encode() in f for f in M.list()[1]))
folder = f'"{enc}"'

# Saving messages
uids = []
for i in (1, 2, 3):
    typ, resp = M.append(folder, "(\\Seen)" if i < 3 else None, imaplib.Time2Internaldate(time.mktime((2026, 11, i, 12, 0, 0, 0, 0, 0))), message(f"Saved {i} {stamp}").as_bytes())
    uids.append(appenduid(resp))
check("APPEND saves messages and answers with their UIDs", all(uids) and uids == sorted(uids), uids)
typ, data = M.select(folder)
check("the folder opens read-write with the three messages", data == [b"3"] and M.response("READ-WRITE")[1] is not None and count(M, enc) == 3)
typ, data = M.uid("FETCH", f"{uids[0]}:{uids[2]}", "(FLAGS INTERNALDATE RFC822.SIZE)")
lines = [d.decode() for d in data]
check("flags and dates given at APPEND are kept", "\\Seen" in lines[0] and "\\Seen" not in lines[2] and "01-Nov-2026" in lines[0] and "03-Nov-2026" in lines[2], lines[2])
typ, data = M.uid("FETCH", str(uids[0]), "(BODY.PEEK[])")
check("a saved message comes back byte for byte", b"Body of the test message." in data[0][1] and f"Saved 1 {stamp}".encode() in data[0][1])

# Flags
typ, data = M.uid("STORE", str(uids[0]), "+FLAGS", "(\\Flagged)")
check("STORE +FLAGS answers with the new flags", typ == "OK" and b"\\Flagged" in data[0] and b"\\Seen" in data[0], data)
listed = api("GET", f"/email/orgs/{ORG}/messages?mailboxId={BOX}&folder=all&subject={urllib.request.quote('Saved 1 ' + stamp)}&limit=5")
check("the web app sees it pinned", any(m.get("pinned") or m.get("isPinned") for m in listed.get("messages", [])), [list(m.keys()) for m in listed.get("messages", [])][:1])
M.uid("STORE", str(uids[0]), "-FLAGS.SILENT", "(\\Flagged \\Seen)")
check("STORE -FLAGS.SILENT clears them", "\\Flagged" not in flags(M, uids[0]) and "\\Seen" not in flags(M, uids[0]), flags(M, uids[0]))
M.uid("STORE", str(uids[0]), "FLAGS", "(\\Answered $Forwarded)")
f = flags(M, uids[0])
check("STORE FLAGS replaces the whole set", "\\Answered" in f and "$Forwarded" in f and "\\Seen" not in f, f)
check("an unread message stays unread after BODY.PEEK", "\\Seen" not in flags(M, uids[2]))
M.uid("FETCH", str(uids[2]), "(BODY[])")
check("reading it with BODY[] marks it read", "\\Seen" in flags(M, uids[2]), flags(M, uids[2]))

# Copy and move
typ, data = M.uid("COPY", str(uids[0]), "Archive")
copyuid = M.response("COPYUID")[1]
check("COPY answers with COPYUID and Archive has one more", typ == "OK" and copyuid and copyuid[0] and count(M, "Archive") == before["Archive"] + 1, copyuid)
typ, data = M.uid("MOVE", str(uids[1]), "Archive")
gone = M.response("EXPUNGE")[1]
check("MOVE takes the message out of this folder and into Archive", typ == "OK" and gone == [b"2"] and count(M, enc) == 2 and count(M, "Archive") == before["Archive"] + 2, gone)
check("moving to a folder that doesn't exist says TRYCREATE", b"TRYCREATE" in M.uid("MOVE", str(uids[0]), '"No such folder"')[1][0])

# Deleting
M.uid("STORE", f"{uids[0]},{uids[2]}", "+FLAGS", "(\\Deleted)")
check("\\Deleted shows as a flag until EXPUNGE", "\\Deleted" in flags(M, uids[2]) and count(M, enc) == 2)
check("SEARCH DELETED finds them", len(M.uid("SEARCH", None, "DELETED")[1][0].split()) == 2)
typ, data = M.expunge()
check("EXPUNGE empties the folder", typ == "OK" and count(M, enc) == 0, data)
check("the message that was only here went to Trash", count(M, "Trash") == before["Trash"] + 1, f'{before["Trash"]} -> {count(M, "Trash")}')
check("the one that was also in Archive just left this folder", count(M, "Archive") == before["Archive"] + 2)
M.select("Trash")
t = uid_of(M, f"Saved 3 {stamp}")
M.uid("STORE", str(t[0]), "+FLAGS", "(\\Deleted)"); M.uid("EXPUNGE", str(t[0]))
check("deleting from Trash removes it for good", count(M, "Trash") == before["Trash"] and uid_of(M, f"Saved 3 {stamp}") == [])

# Drafts: a mail app saves a new version and deletes the old one, over and over
typ, resp = M.append("Drafts", "(\\Draft)", None, message(f"Draft v1 {stamp}").as_bytes()); d1 = appenduid(resp)
typ, resp = M.append("Drafts", "(\\Draft)", None, message(f"Draft v2 {stamp}").as_bytes()); d2 = appenduid(resp)
M.select("Drafts")
check("a saved draft has the \\Draft flag", "\\Draft" in flags(M, d2), flags(M, d2))
M.uid("STORE", str(d1), "+FLAGS", "(\\Deleted)"); M.expunge()
check("the old draft version is gone for good, not in Trash", count(M, "Drafts") == before["Drafts"] + 1 and count(M, "Trash") == before["Trash"])
M.uid("STORE", str(d2), "+FLAGS", "(\\Deleted)"); M.expunge()

# The mail app's own copy of what it sent
sent1 = message(f"Sent once A {stamp}")
smtp_send(sent1)
typ, resp = M.append("Sent", "(\\Seen)", None, sent1.as_bytes())
M.select("Sent")
check("saving a copy of a message already sent adds nothing", typ == "OK" and uid_of(M, f"Sent once A {stamp}") == [appenduid(resp)], resp)
sent2 = message(f"Sent once B {stamp}")
M.append("Sent", "(\\Seen)", None, sent2.as_bytes()); smtp_send(sent2); M.noop()
check("saving the copy first and sending after also leaves one", len(uid_of(M, f"Sent once B {stamp}")) == 1, uid_of(M, f"Sent once B {stamp}"))

# A reply marks the original answered
original = message(f"Question {stamp}", mid=f"<q{stamp}@elsewhere.test>")
typ, resp = M.append("INBOX", None, None, original.as_bytes()); q = appenduid(resp)
smtp_send(message(f"Re: Question {stamp}", reply_to=f"<q{stamp}@elsewhere.test>"))
M.select("INBOX")
check("replying from the mail app marks the original answered", "\\Answered" in flags(M, q), flags(M, q))

# Junk button
M.uid("STORE", str(q), "+FLAGS", "($Junk)")
check("the Junk button moves the message to Junk", count(M, "INBOX") == before["INBOX"] and count(M, "Junk") == before["Junk"] + 1)
M.select("Junk"); j = uid_of(M, f"Question {stamp}")
M.uid("STORE", str(j[0]), "+FLAGS", "($NotJunk)")
check("Not junk brings it back to the Inbox", count(M, "INBOX") == before["INBOX"] + 1 and count(M, "Junk") == before["Junk"])

# Read-only
M.select(folder, readonly=True)
check("a folder opened with EXAMINE refuses changes", M.uid("STORE", "1:*", "+FLAGS", "(\\Seen)")[0] == "NO" and M.expunge()[0] == "NO")

# A large message
# imaplib sends every line break as CRLF, so that is the size to expect back.
big = re.sub(rb"\r\n|\r|\n", b"\r\n", message(f"Large {stamp}", size=15 * 1024 * 1024).as_bytes())
t0 = time.time(); typ, resp = M.append(folder, None, None, big); b = appenduid(resp)
M.select(folder)
typ, data = M.uid("FETCH", str(b), "(RFC822.SIZE)")
check("a 20 MB message can be saved", typ == "OK" and int(re.search(rb"RFC822.SIZE (\d+)", data[0]).group(1)) == len(big), f"{len(big) / 1048576:.1f} MB in {time.time() - t0:.1f}s")

# Deleting a folder keeps its mail
trash_before = count(M, "Trash")
check("DELETE removes the folder and its message goes to Trash", M.delete(folder)[0] == "OK" and not any(enc.encode() in f for f in M.list()[1]) and count(M, "Trash") == trash_before + 1)

# Tidy up what this test left behind
for box, subjects in (("Trash", [f"Large {stamp}", f"Saved 1 {stamp}"]), ("Archive", [f"Saved 1 {stamp}", f"Saved 2 {stamp}"]), ("INBOX", [f"Question {stamp}"])):
    M.select(box)
    for s in subjects:
        for u in uid_of(M, s): M.uid("STORE", str(u), "+FLAGS", "(\\Deleted)")
    M.expunge()
M.select("Trash")
for s in (f"Saved 1 {stamp}", f"Saved 2 {stamp}", f"Question {stamp}"):
    for u in uid_of(M, s): M.uid("STORE", str(u), "+FLAGS", "(\\Deleted)")
M.expunge()
M.logout()
api("DELETE", f"/orgs/{ORG}/app-passwords/{pw_id}")
sys.exit(1 if failed else 0)
