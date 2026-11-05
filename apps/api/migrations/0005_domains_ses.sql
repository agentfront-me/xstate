-- Amazon SES state per domain (mailserver/ses.ts). Outbound mail goes through SES, which only sends for verified
-- domains and signs with each domain's own Easy DKIM key.
ALTER TABLE domains ADD COLUMN ses_status TEXT CHECK (ses_status IN ('pending', 'verified', 'failed'));  -- NULL: not registered yet
ALTER TABLE domains ADD COLUMN ses_dkim_tokens TEXT;  -- JSON array; the customer publishes <token>._domainkey CNAME <token>.dkim.amazonses.com
