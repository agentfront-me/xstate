#!/usr/bin/env python3
"""Local end-to-end test of reading mail from a mail app (docs/imap-smtp-relay-plan.md §6): Python's imaplib as the
mail app -> mail bridge -> Worker -> ImapSession -> the mailbox store and R2. Needs the `api-relay` dev server (port
8826), the bridge on 127.0.0.1:1993 and :1465, and the same local test data as smtp-test.py. Run from apps/api:
  ORG_ID=… USER_ID=… OWN=… OWN_MAILBOX_ID=… python3 scripts/imap-test.py"""
import base64, email, hashlib, hmac, imaplib, json, os, re, smtplib, ssl, sys, time, urllib.request
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
    print(f'{"PASS" if ok else "FAIL"}  {name}{"  " + str(detail)[:150] if detail else ""}', flush=True)

ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
pw = api("POST", f"/orgs/{ORG}/app-passwords", {"name": "IMAP test"}); secret_pw, pw_id = pw["secret"], pw["password"]["id"]
stamp = str(int(time.time()))
attachment = b"attached text\n" * 50

def send(subject, files=()):
    m = EmailMessage(); m["From"] = f"Jay Test <{OWN}>"; m["To"] = "Ann Lee <ann@outside.test>, bob@outside.test"; m["Subject"] = subject
    m["Message-ID"] = f"<{time.time_ns()}@laptop.local>"
    m.set_content("Hello from the IMAP test.\n.\n..two dots at the start of a line\n")
    for name, data in files: m.add_attachment(data, maintype="application", subtype="octet-stream", filename=name)
    s = smtplib.SMTP_SSL("127.0.0.1", 1465, context=ctx, timeout=120); s.login(OWN, secret_pw); s.send_message(m); s.quit()
subject = f"IMAP test {stamp}"
send(subject, [("notes.txt", attachment)])
time.sleep(1)

M = imaplib.IMAP4_SSL("127.0.0.1", 1993, ssl_context=ctx, timeout=120)
check("the greeting offers IMAP4rev1, IDLE and AUTH=PLAIN", all(c in M.capabilities for c in ("IMAP4REV1", "IDLE", "AUTH=PLAIN")), M.capabilities)
try: M.login(OWN, "aaaa-bbbb-cccc-dddd"); check("a wrong password is refused", False)
except imaplib.IMAP4.error as e: check("a wrong password is refused", "AUTHENTICATIONFAILED" in str(e))
M.login(OWN, secret_pw)
typ, folders = M.list()
names = [f.decode() for f in folders]
check("LIST shows the six folders, with their roles", all(any(x in n for n in names) for x in ('"INBOX"', '\\Sent) "/" "Sent"', '\\Trash', '\\Drafts', '\\Junk', '\\Archive')), names)
typ, st = M.status("Sent", "(MESSAGES UIDNEXT UIDVALIDITY UNSEEN)")
messages = int(re.search(rb"MESSAGES (\d+)", st[0]).group(1))
check("STATUS counts the Sent folder", messages >= 1, st[0].decode())
typ, data = M.select("Sent", readonly=True)
exists = int(data[0])
check("the folder opens read-only with the same count", exists == messages, f"{exists} messages")
typ, data = M.fetch("1:*", "(UID FLAGS)")
uids = [int(re.search(rb"UID (\d+)", d).group(1)) for d in data]
check("FETCH 1:* (UID FLAGS) answers for every message, UIDs ascending", len(uids) == exists and uids == sorted(uids) and all(b"\\Seen" in d for d in data))

typ, found = M.uid("SEARCH", None, "SUBJECT", f'"{subject}"')
check("UID SEARCH SUBJECT finds the message just sent", len(found[0].split()) == 1, found)
uid = found[0].split()[0].decode()
typ, found = M.search(None, "TEXT", '"two dots"', "SINCE", time.strftime("%d-%b-%Y", time.gmtime(time.time() - 86400)))
check("SEARCH TEXT … SINCE finds it by body words", str(uids.index(int(uid)) + 1).encode() in found[0].split(), found)
check("SEARCH for something that isn't there is empty", M.search(None, "SUBJECT", '"no such subject zzz"')[1] == [b""])
try: M.search(None, "SHINY"); check("an unknown search key is refused", False)
except imaplib.IMAP4.error: check("an unknown search key is refused", True)

typ, data = M.uid("FETCH", uid, "(UID RFC822.SIZE FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (From To Subject Date Message-ID)])")
head = email.message_from_bytes(data[0][1])
size = int(re.search(rb"RFC822.SIZE (\d+)", data[0][0]).group(1))
check("header fields come back as written", head["Subject"] == subject and "Ann Lee" in head["To"] and head["Message-ID"].endswith("amazonses.com>"), dict(head))
typ, data = M.uid("FETCH", uid, "(ENVELOPE BODYSTRUCTURE)")
line = b" ".join(d if isinstance(d, bytes) else b" ".join(d) for d in data).decode()
check("ENVELOPE has the subject and the people", f'"{subject}"' in line and '("Ann Lee" NIL "ann" "outside.test")' in line and '("Jay Test" NIL' in line, line[:200])
check("BODYSTRUCTURE shows the text and the attachment", '"text" "plain"' in line.lower() and '"filename" "notes.txt"' in line and '"mixed"' in line.lower(), line[-260:])

typ, data = M.uid("FETCH", uid, "(BODY.PEEK[])")
raw = data[0][1]
msg = email.message_from_bytes(raw)
parts = list(msg.walk())
check("the whole message is the size RFC822.SIZE promised", len(raw) == size, f"{len(raw)} vs {size}")
check("its text survived, lines starting with dots included", "..two dots at the start of a line" in parts[1].get_content() if hasattr(parts[1], "get_content") else "..two dots" in parts[1].get_payload())
check("its attachment is byte-for-byte what was sent", parts[2].get_payload(decode=True) == attachment)
typ, data = M.uid("FETCH", uid, "(BODY.PEEK[2])")
check("BODY[2] is the attachment's encoded body", base64.b64decode(data[0][1]) == attachment)
typ, data = M.uid("FETCH", uid, "(BODY.PEEK[1])")
check("BODY[1] is the text part", b"Hello from the IMAP test." in data[0][1])
typ, data = M.uid("FETCH", uid, "(BODY.PEEK[2.MIME])")
check("BODY[2.MIME] is the attachment's own headers", b"notes.txt" in data[0][1] and data[0][1].endswith(b"\r\n\r\n"))
typ, data = M.uid("FETCH", uid, "(BODY.PEEK[]<0.100>)")
check("a partial fetch returns just those bytes", data[0][1] == raw[:100] and b"BODY[]<0>" in data[0][0])
typ, data = M.uid("FETCH", uid, "(BODY.PEEK[TEXT])")
check("BODY[TEXT] is everything after the headers", raw.endswith(data[0][1]) and len(data[0][1]) < len(raw))
typ, data = M.uid("FETCH", uid, "(BODY.PEEK[9])")
check("a part that doesn't exist is an empty string", b'BODY[9] ""' in data[0] if isinstance(data[0], bytes) else b'""' in data[0][0], data)

typ, data = M.fetch("1:*", "(UID RFC822.SIZE ENVELOPE BODYSTRUCTURE)")
check("ENVELOPE and BODYSTRUCTURE for the whole folder at once", typ == "OK" and sum(1 for d in data if isinstance(d, (bytes, tuple)) and b"ENVELOPE" in (d if isinstance(d, bytes) else d[0])) >= 1, len(data))
# Locally the dev server reads the real R2 bucket over the internet, so big downloads are only checked with LARGE=1.
typ, found = M.uid("SEARCH", None, "LARGER", "10000000") if os.environ.get("LARGE") else ("OK", [b""])
if found[0]:
    big = found[0].split()[-1].decode()
    t = time.time()
    typ, data = M.uid("FETCH", big, "(RFC822.SIZE BODY.PEEK[])")
    want = int(re.search(rb"RFC822.SIZE (\d+)", data[0][0]).group(1))
    check("a message over 10 MB downloads whole", len(data[0][1]) == want, f"{want / 1048576:.1f} MB in {time.time() - t:.1f}s")
typ, data = M.uid("STORE", uid, "+FLAGS", "(\\Flagged)")
check("STORE is refused in a folder opened read-only", typ == "NO", data)

print("  waiting 15s so the session sleeps…", flush=True); time.sleep(15)
typ, data = M.fetch(str(exists), "(UID)")
check("after sleeping, sequence numbers still map to the same UIDs", int(re.search(rb"UID (\d+)", data[0]).group(1)) == uids[-1])

# IDLE: a new Sent copy, then a flag change made in the web app, must each reach the idle connection.
tag = M._new_tag().decode(); M.send(f"{tag} IDLE\r\n".encode())
check("IDLE is accepted", M.readline().startswith(b"+"))
send(f"While idle {stamp}")
M.sock.settimeout(20)
try: line = M.readline()
except Exception as e: line = repr(e).encode()
check("a new message reaches the idle mail app", line.strip() == f"* {exists + 1} EXISTS".encode(), line)
sent = api("GET", f"/email/orgs/{ORG}/messages?mailboxId={BOX}&folder=sent&subject={urllib.request.quote(subject)}&limit=1")
r = api("PATCH", f"/email/mailboxes/{BOX}/messages/{sent['messages'][0]['id']}", {"pinned": True})
try: line = M.readline()
except Exception as e: line = repr(e).encode()
check("a flag changed in the web app reaches it too", b"FETCH" in line and f"UID {uid} ".encode() in line and b"\\Flagged" in line, line)
M.send(b"DONE\r\n")
check("DONE ends IDLE", M.readline().startswith(f"{tag} OK".encode()))
api("PATCH", f"/email/mailboxes/{BOX}/messages/{sent['messages'][0]['id']}", {"pinned": False})
typ, data = M.noop()
flagline = b" ".join(x for x in (M.response("FETCH")[1] or []) if x)
check("NOOP reports the flag going off again", f"UID {uid} ".encode() in flagline and b"\\Flagged" not in flagline, flagline)

typ, data = M.select("INBOX", readonly=True)
check("switching to INBOX works", typ == "OK", data)
typ, data = M.select("No such folder", readonly=True)
check("a folder that doesn't exist is refused", typ == "NO")
M.logout()
api("DELETE", f"/orgs/{ORG}/app-passwords/{pw_id}")
sys.exit(1 if failed else 0)
