-- Plans and billing through Paddle (src/billing/, docs/pricing-plan.md). One subscription per organization at most.
-- plan is what the organization gets now: 'free' unless its Paddle subscription is active, trialing or past due
-- (Paddle is still retrying the payment). Everything else mirrors the subscription as Paddle last reported it;
-- billing_event_at is that report's time, so an older webhook arriving late can't overwrite a newer one.
ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team'));
ALTER TABLE organizations ADD COLUMN billing_interval TEXT CHECK (billing_interval IN ('month', 'year'));
ALTER TABLE organizations ADD COLUMN paddle_customer_id TEXT;
ALTER TABLE organizations ADD COLUMN paddle_subscription_id TEXT;
-- Paddle's status: active, trialing, past_due, paused or canceled.
ALTER TABLE organizations ADD COLUMN subscription_status TEXT;
-- People (personal mailboxes) the subscription is billed for, as Paddle last reported it.
ALTER TABLE organizations ADD COLUMN billed_seats INTEGER;
ALTER TABLE organizations ADD COLUMN current_period_end TEXT;
-- A change Paddle will apply at current_period_end, e.g. {"action":"cancel","effectiveAt":"…"}.
ALTER TABLE organizations ADD COLUMN scheduled_change TEXT;
ALTER TABLE organizations ADD COLUMN billing_event_at TEXT;
CREATE UNIQUE INDEX organizations_paddle_subscription_idx ON organizations (paddle_subscription_id)
  WHERE paddle_subscription_id IS NOT NULL;
