#!/usr/bin/env python3
"""Local end-to-end test of calendar apps over CalDAV (docs/imap-smtp-relay-plan.md §7): the requests Apple Calendar
and DAVx⁵ make, in their order, against the `api-relay` dev server (port 8826). Same local test data as
imap-test.py. Run from apps/api:  ORG_ID=… USER_ID=… OWN=… OWN_MAILBOX_ID=… READ_ONLY=… python3 scripts/caldav-test.py"""
import base64, hashlib, hmac, json, os, re, sys, time, urllib.request, uuid, xml.etree.ElementTree as ET

API = os.environ.get("API", "http://localhost:8826")
ORG, USER, OWN, BOX, READ_ONLY = (os.environ[k] for k in ("ORG_ID", "USER_ID", "OWN", "OWN_MAILBOX_ID", "READ_ONLY"))
secret = re.search(r"^JWT_SECRET=(.*)$", open(".dev.vars").read(), re.M).group(1).strip().strip('"')
b64 = lambda v: base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b"=").decode()
def jwt(sub):
    now = int(time.time()); body = f'{b64({"alg":"HS256","typ":"JWT"})}.{b64({"sub":sub,"iat":now,"exp":now+900})}'
    return body + "." + base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
def api(method, path, body=None):
    req = urllib.request.Request(f"{API}/v1{path}", method=method, data=json.dumps(body).encode() if body else None, headers={"Authorization": f"Bearer {jwt(USER)}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return {"status": e.code, **json.loads(e.read() or b"{}")}
failed = False
def check(name, ok, detail=""):
    global failed; failed |= not ok
    print(f'{"PASS" if ok else "FAIL"}  {name}{"  " + str(detail)[:170] if detail else ""}', flush=True)

pw = api("POST", f"/orgs/{ORG}/app-passwords", {"name": "CalDAV test"})["secret"]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)
def dav(method, path, body=None, user=OWN, password=None, headers=None):
    h = {"Authorization": "Basic " + base64.b64encode(f"{user}:{password or pw}".encode()).decode(), "Content-Type": "application/xml; charset=utf-8", **(headers or {})}
    req = urllib.request.Request(path if path.startswith("http") else API + path, method=method, data=body.encode() if isinstance(body, str) else body, headers=h)
    try:
        with opener.open(req) as r: return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e: return e.code, dict(e.headers), e.read().decode()
NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav", "cs": "http://calendarserver.org/ns/", "a": "http://apple.com/ns/ical/"}
def responses(text):
    root = ET.fromstring(text); out = {}
    for r in root.findall("d:response", NS):
        props = {}
        for ps in r.findall("d:propstat", NS):
            if "200" in ps.findtext("d:status", "", NS):
                for p in ps.find("d:prop", NS): props[p.tag] = p
        out[r.findtext("d:href", "", NS)] = (props, r.findtext("d:status", "", NS))
    return out, root
D, C, CS, A = "{DAV:}", "{urn:ietf:params:xml:ns:caldav}", "{http://calendarserver.org/ns/}", "{http://apple.com/ns/ical/}"

# Discovery, as Apple Calendar does it
st, h, _ = dav("PROPFIND", "/.well-known/caldav")
check("/.well-known/caldav redirects to /dav/", st == 301 and h.get("Location") == "/dav/", st)
st, h, _ = dav("PROPFIND", "/dav/", password="aaaa-bbbb-cccc-dddd")
check("a wrong app password gets 401 with a Basic challenge", st == 401 and "Basic" in h.get("WWW-Authenticate", ""))
st, _, body = dav("PROPFIND", "/dav/", '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', headers={"Depth": "0"})
principal = list(responses(body)[0].values())[0][0][D + "current-user-principal"].findtext("d:href", "", NS)
check("the current user principal is the mailbox", principal == f"/dav/principals/{BOX}/", principal)
st, _, body = dav("PROPFIND", principal, '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/><c:calendar-user-address-set/><d:displayname/></d:prop></d:propfind>', headers={"Depth": "0"})
props = list(responses(body)[0].values())[0][0]
homeurl = props[C + "calendar-home-set"].findtext("d:href", "", NS)
check("the principal names its calendar home and email address", homeurl == f"/dav/calendars/{BOX}/" and props[C + "calendar-user-address-set"].findtext("d:href", "", NS) == f"mailto:{OWN}")
st, _, body = dav("PROPFIND", homeurl, '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><cs:getctag/><d:sync-token/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/></d:prop></d:propfind>', headers={"Depth": "1"})
cals = {u: p for u, (p, _) in responses(body)[0].items() if p.get(D + "resourcetype") is not None and p[D + "resourcetype"].find("c:calendar", NS) is not None}
check("the home lists the calendars, each with a name, color and sync token", len(cals) >= 1 and all(D + "displayname" in p and A + "calendar-color" in p and D + "sync-token" in p for p in cals.values()), [p[D + "displayname"].text for p in cals.values()])
calurl = next(u for u, p in cals.items() if p[D + "displayname"].text == "Work") if any(p[D + "displayname"].text == "Work" for p in cals.values()) else list(cals)[0]
token = cals[calurl][D + "sync-token"].text

# Creating an event, as Apple Calendar does: PUT with If-None-Match: *
uid = str(uuid.uuid4()).upper()
ics = f"""BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//macOS 15.0//EN\r\nCALSCALE:GREGORIAN\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Karachi\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0500\r\nTZOFFSETTO:+0500\r\nTZNAME:PKT\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20261120T100000Z\r\nDTSTART;TZID=Asia/Karachi:20261125T100000\r\nDTEND;TZID=Asia/Karachi:20261125T110000\r\nSUMMARY:CalDAV test meeting\r\nLOCATION:Room 4\r\nDESCRIPTION:Made in a calendar app\r\nSEQUENCE:0\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"""
evurl = f"{calurl}{uid}.ics"
st, h, _ = dav("PUT", evurl, ics, headers={"Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*"})
check("PUT creates the event and answers with an ETag", st == 201 and h.get("ETag"), (st, h.get("ETag")))
etag1 = h.get("ETag")
st, h, text = dav("GET", evurl)
check("GET gives it back as iCalendar without a METHOD", st == 200 and "SUMMARY:CalDAV test meeting" in text and "METHOD" not in text and f"UID:{uid}" in text and "Asia/Karachi" in text, text[:120])
web = api("GET", f"/calendar/mailboxes/{BOX}/events?from=2026-11-24T00:00:00Z&to=2026-11-27T00:00:00Z")
evs = web.get("events", web if isinstance(web, list) else [])
check("the web app sees the event at the right time", any(e.get("title") == "CalDAV test meeting" for e in evs) if evs else False, str(web)[:160])
st, h, _ = dav("PUT", evurl, ics, headers={"Content-Type": "text/calendar", "If-None-Match": "*"})
check("PUT with If-None-Match: * on an existing event is refused (412)", st == 412, st)

# Changing it
st, h, _ = dav("PUT", evurl, ics.replace("CalDAV test meeting", "CalDAV test meeting, moved").replace("T100000\r\nDTEND", "T120000\r\nDTEND").replace("T110000", "T130000"), headers={"Content-Type": "text/calendar", "If-Match": etag1})
etag2 = h.get("ETag")
check("PUT with the right If-Match changes it and the ETag moves on", st == 204 and etag2 and etag2 != etag1, (st, etag2))
st, h, _ = dav("PUT", evurl, ics, headers={"Content-Type": "text/calendar", "If-Match": etag1})
check("PUT with an old If-Match is refused (412)", st == 412, st)

# Sync, as DAVx⁵ does it
st, _, body = dav("REPORT", calurl, f'<d:sync-collection xmlns:d="DAV:"><d:sync-token>{token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>')
items, root = responses(body)
newtoken = root.findtext("d:sync-token", "", NS)
check("sync-collection from the old token lists the new event", st == 207 and evurl in items and newtoken != token, list(items)[:3])
st, _, body = dav("REPORT", calurl, f'<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>{evurl}</d:href><d:href>{calurl}nope.ics</d:href></c:calendar-multiget>')
items, _ = responses(body)
check("calendar-multiget returns the data, and 404 for one that doesn't exist", "moved" in (items[evurl][0][C + "calendar-data"].text or "") and "404" in items[f"{calurl}nope.ics"][1])
st, _, body = dav("REPORT", calurl, '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261125T000000Z" end="20261126T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')
inday = evurl in responses(body)[0]
st, _, body = dav("REPORT", calurl, '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20270101T000000Z" end="20270102T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')
check("calendar-query with a time range finds it only in its own day", inday and evurl not in responses(body)[0])

# An event made in the web app shows up in the calendar app
made = api("POST", f"/calendar/mailboxes/{BOX}/events", {"calendarId": calurl.rstrip("/").split("/")[-1], "title": "Made in the web app", "start": "2026-11-26T09:00", "end": "2026-11-26T09:30", "timeZone": "Asia/Karachi"})
st, _, body = dav("REPORT", calurl, f'<d:sync-collection xmlns:d="DAV:"><d:sync-token>{newtoken}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:prop></d:sync-collection>')
items, root = responses(body)
check("an event made in the web app reaches the calendar app on its next sync", any("Made in the web app" in (p.get(C + "calendar-data").text or "") for p, _ in items.values() if p.get(C + "calendar-data") is not None), str(made)[:120])
token3 = root.findtext("d:sync-token", "", NS)

# Deleting
st, _, _ = dav("DELETE", evurl, headers={"If-Match": etag2})
check("DELETE removes it", st == 204 and dav("GET", evurl)[0] == 404, st)
st, _, body = dav("REPORT", calurl, f'<d:sync-collection xmlns:d="DAV:"><d:sync-token>{token3}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>')
items, _ = responses(body)
check("the next sync reports it as deleted (404)", evurl in items and "404" in items[evurl][1], list(items.items())[:2])

# Calendars
newcal = f"{homeurl}{uuid.uuid4()}/"
# MKCALENDAR, as Apple Calendar sends it; the Workers runtime may refuse that method name (501), so also MKCOL with
# a calendar resourcetype (RFC 5689), as DAVx⁵ and Thunderbird send it.
st, _, _ = dav("MKCALENDAR", newcal, '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>Side project</d:displayname><a:calendar-color>#FF2968FF</a:calendar-color></d:prop></d:set></c:mkcalendar>')
print(f"  MKCALENDAR answered {st}")
if st != 201:
    st, _, _ = dav("MKCOL", newcal, '<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Side project</d:displayname><a:calendar-color>#FF2968FF</a:calendar-color></d:prop></d:set></d:mkcol>')
st2, _, body = dav("PROPFIND", newcal, '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>', headers={"Depth": "0"})
check("MKCALENDAR makes a calendar where the app asked", st == 201 and "Side project" in body, (st, st2))
st, _, body = dav("PROPPATCH", newcal, '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Side project 2</d:displayname></d:prop></d:set></d:propertyupdate>')
check("PROPPATCH renames it", st == 207 and "Side project 2" in dav("PROPFIND", newcal, '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>', headers={"Depth": "0"})[2])
check("DELETE removes the calendar", dav("DELETE", newcal)[0] == 204 and dav("PROPFIND", newcal, headers={"Depth": "0"})[0] == 404)
check("the default calendar can't be deleted", dav("DELETE", calurl)[0] == 403)

# Other mailboxes and read-only access
other = "/dav/calendars/someone-else/"
check("another mailbox's calendars are not found", dav("PROPFIND", other, headers={"Depth": "0"})[0] == 404)
st, _, body = dav("PROPFIND", "/dav/", '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', user=READ_ONLY, headers={"Depth": "0"})
ro_principal = re.search(r"/dav/principals/([^/]+)/", body).group(1)
st, _, body = dav("PROPFIND", f"/dav/calendars/{ro_principal}/", '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', user=READ_ONLY, headers={"Depth": "1"})
rocal = [u for u in responses(body)[0] if u.count("/") == 5][0]
st, _, _ = dav("PUT", f"{rocal}x.ics", ics, user=READ_ONLY, headers={"Content-Type": "text/calendar"})
check("a read-only shared mailbox can read its calendars but not change them", st == 403, st)

# Tidy up the web app's event
for e in api("GET", f"/calendar/mailboxes/{BOX}/events?from=2026-11-25T00:00:00Z&to=2026-11-28T00:00:00Z").get("events", []):
    if e.get("title") == "Made in the web app": api("DELETE", f"/calendar/mailboxes/{BOX}/events/{e['id']}")
sys.exit(1 if failed else 0)
