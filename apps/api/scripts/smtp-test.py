#!/usr/bin/env python3
"""Local end-to-end test of sending from a mail app (docs/imap-smtp-relay-plan.md §5): Python's smtplib as the mail
app -> mail bridge -> Worker -> SmtpSession -> the store send path (SES in fake mode). Needs the `api-relay` dev
server (port 8826), the bridge on 127.0.0.1:1465 (TLS) and :1587 (STARTTLS), and the same local test data as
app-password-test.mjs. Run from apps/api:
  ORG_ID=… USER_ID=… ADMIN_ID=… OWN=… OWN_MAILBOX_ID=… READ_ONLY=… python3 scripts/smtp-test.py"""
import base64, hashlib, hmac, json, os, re, smtplib, ssl, sys, time, urllib.request
from email.message import EmailMessage

API = os.environ.get("API", "http://localhost:8826")
ORG, USER, ADMIN, OWN, BOX, READ_ONLY = (os.environ[k] for k in ("ORG_ID", "USER_ID", "ADMIN_ID", "OWN", "OWN_MAILBOX_ID", "READ_ONLY"))
secret = re.search(r"^JWT_SECRET=(.*)$", open(".dev.vars").read(), re.M).group(1).strip().strip('"')
b64 = lambda v: base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b"=").decode()
def jwt(sub):
    now = int(time.time()); body = f'{b64({"alg":"HS256","typ":"JWT"})}.{b64({"sub":sub,"iat":now,"exp":now+600})}'
    return body + "." + base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
def api(method, path, body=None, user=None):
    req = urllib.request.Request(f"{API}/v1{path}", method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {jwt(user or USER)}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return {"status": e.code, **json.loads(e.read() or b"{}")}
failed = False
def check(name, ok, detail=""):
    global failed; failed |= not ok
    print(f'{"PASS" if ok else "FAIL"}  {name}{"  " + str(detail) if detail else ""}')

ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
def connect(starttls=False):
    if starttls:
        s = smtplib.SMTP("127.0.0.1", 1587, timeout=120); s.starttls(context=ctx); s.ehlo(); return s
    return smtplib.SMTP_SSL("127.0.0.1", 1465, context=ctx, timeout=120)
def message(subject, to, cc=None, bcc=None, sender=None, files=()):
    m = EmailMessage(); m["From"] = f"Jay Test <{sender or OWN}>"; m["To"] = ", ".join(to); m["Subject"] = subject
    if cc: m["Cc"] = ", ".join(cc)
    if bcc: m["Bcc"] = ", ".join(bcc)
    m["Message-ID"] = f"<{time.time_ns()}@laptop.local>"
    m.set_content(f"Hello from a mail app.\n.\n..two dots at the start of a line\nSubject was: {subject}\n")
    for name, data in files: m.add_attachment(data, maintype="application", subtype="octet-stream", filename=name)
    return m
def refused(fn):
    try: fn(); return None
    except smtplib.SMTPResponseException as e: return f"{e.smtp_code} {e.smtp_error.decode(errors='replace')}"
    except smtplib.SMTPRecipientsRefused as e: code, text = next(iter(e.recipients.values())); return f"{code} {text.decode()}"
    except smtplib.SMTPSenderRefused as e: return f"{e.smtp_code} {e.smtp_error.decode()}"
    except smtplib.SMTPServerDisconnected as e: return f"disconnected: {e}"

pw = api("POST", f"/orgs/{ORG}/app-passwords", {"name": "SMTP test"}); secret_pw, pw_id = pw["secret"], pw["password"]["id"]
stamp = str(int(time.time()))

s = connect(); s.ehlo()
check("EHLO offers AUTH, SIZE and PIPELINING", all(s.has_extn(x) for x in ("auth", "size", "pipelining")), s.esmtp_features)
check("MAIL before signing in is refused", (refused(lambda: s.sendmail(OWN, ["a@outside.test"], "x")) or "").startswith("530"))
s.rset(); s.login(OWN, secret_pw)
subject = f"SMTP test {stamp}"
m = message(subject, ["ann@outside.test"], cc=["cy@outside.test"], bcc=["hidden@outside.test"], files=[("notes.txt", b"attached text\n" * 50)])
check("a message with Cc, Bcc and an attachment is accepted", refused(lambda: s.send_message(m)) is None)
m2 = message(f"Second {stamp}", ["ann@outside.test"])
check("a second message on the same connection", refused(lambda: s.send_message(m2)) is None)
check("a From address that isn't the mailbox's is refused", (refused(lambda: s.sendmail(OWN, ["a@outside.test"], message("x", ["a@outside.test"], sender="ceo@other.test").as_bytes())) or "").startswith("550"))
check("MAIL FROM another address is refused", (refused(lambda: s.sendmail("ceo@other.test", ["a@outside.test"], "x")) or "").startswith("550"))
s.rset()
check("a blocked file type is refused, and says which file", "setup.exe" in (refused(lambda: s.send_message(message("exe", ["a@outside.test"], files=[("setup.exe", b"MZ" + b"\0" * 200)]))) or ""))
# Addresses on the mailbox's own domain: they don't count toward the hourly limit on outside recipients.
many = [f"p{i}@{OWN.split('@')[1]}" for i in range(51)]
left_out = s.send_message(message(f"Many {stamp}", many))
check("the 51st recipient is refused and the other 50 are sent", len(left_out) == 1 and next(iter(left_out.values()))[0] == 452, left_out)
s.rset()
big = message(f"Big {stamp}", ["ann@outside.test"], files=[("big.bin", os.urandom(18 * 1024 * 1024))])
t = time.time(); r = refused(lambda: s.send_message(big))
check("an 18 MB attachment goes through", r is None, r or f"{time.time() - t:.1f}s")
r = refused(lambda: s.send_message(message("too big", ["ann@outside.test"], files=[("huge.bin", os.urandom(27 * 1024 * 1024))])))
check("27 MB of attachments is refused with 552", r is not None and r.startswith("552"), (r or "")[:80])
try: s.quit()
except Exception: pass

s = connect(starttls=True)
s.docmd("AUTH", "LOGIN"); s.docmd(base64.b64encode(OWN.encode()).decode()); code, _ = s.docmd(base64.b64encode(secret_pw.encode()).decode())
check("port 587 with STARTTLS and AUTH LOGIN signs in", code == 235, code)
check("and sends", refused(lambda: s.send_message(message(f"Via 587 {stamp}", ["ann@outside.test"]))) is None)
s.quit()

s = connect(); s.login(READ_ONLY, secret_pw)
check("a read-only shared mailbox can sign in but not send", (refused(lambda: s.sendmail(READ_ONLY, ["a@outside.test"], "x")) or "").startswith("550"))
s.quit()

s = connect(); tries = [refused(lambda: s.login(OWN, "aaaa-bbbb-cccc-dddd")) for _ in range(3)]
check("three wrong passwords close the connection", "535" in (tries[0] or "") and "disconnected" in (refused(lambda: s.noop()) or "disconnected"), tries[-1])

time.sleep(2)
sent = api("GET", f"/email/orgs/{ORG}/messages?mailboxId={BOX}&folder=sent&limit=20")
mine = [x for x in sent.get("messages", []) if stamp in x.get("subject", "")]
check("each sent message has exactly one Sent copy", sorted(x["subject"] for x in mine) == sorted([subject, f"Second {stamp}", f"Many {stamp}", f"Big {stamp}", f"Via 587 {stamp}"]), [x["subject"] for x in mine])
first = next((x for x in mine if x["subject"] == subject), None)
if first:
    thread = api("GET", f"/email/mailboxes/{BOX}/threads/{first['threadId']}")
    msg = next((x for x in thread.get("messages", thread.get("emails", [])) if x["id"] == first["id"]), {})
    body = json.dumps(msg)
    check("the Sent copy has the text with its dots intact", "..two dots at the start of a line" in body and "\\n.\\n" in body)
    check("the Sent copy remembers the Bcc and the attachment", "hidden@outside.test" in body and "notes.txt" in body)
log = api("GET", f"/email/orgs/{ORG}/delivery-log?mailboxId={BOX}&query=hidden@outside.test", user=ADMIN)
check("the delivery log has a line for the Bcc recipient", "hidden@outside.test" in json.dumps(log), str(log)[:120] if "hidden" not in json.dumps(log) else "")
api("DELETE", f"/orgs/{ORG}/app-passwords/{pw_id}")
sys.exit(1 if failed else 0)
