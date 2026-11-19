-- Billing without a fixed provider (docs/billing-limits-plan.md §3.2). Replaces the Paddle per-person columns of
-- 0031: plans are now free, growth and custom (docs/pricing-plan.md §8a), and the subscription is mirrored from
-- whichever provider BILLING_PROVIDER names. No organization had a paid subscription when this ran (2026-11-19),
-- so the dropped columns held nothing.
DROP INDEX IF EXISTS organizations_paddle_subscription_idx;
ALTER TABLE organizations DROP COLUMN plan;
ALTER TABLE organizations DROP COLUMN billing_interval;
ALTER TABLE organizations DROP COLUMN paddle_customer_id;
ALTER TABLE organizations DROP COLUMN paddle_subscription_id;
ALTER TABLE organizations DROP COLUMN billed_seats;
ALTER TABLE organizations DROP COLUMN scheduled_change;

-- What the organization gets now: 'free' unless its subscription bills (active, trialing or past due), or 'custom'
-- when an admin set it up by hand.
ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'growth', 'custom'));
-- 'stripe' or 'paddle': who holds the customer and subscription below.
ALTER TABLE organizations ADD COLUMN billing_provider TEXT;
ALTER TABLE organizations ADD COLUMN billing_customer_id TEXT;
ALTER TABLE organizations ADD COLUMN billing_subscription_id TEXT;
-- Growth's paid size above 5,000 people, in hundreds ("Extra 100 people" quantity), as the provider last reported it.
ALTER TABLE organizations ADD COLUMN extra_hundreds INTEGER;
-- When a scheduled cancellation takes effect.
ALTER TABLE organizations ADD COLUMN cancel_at TEXT;
-- Custom plan limits set by an admin (JSON), overriding the plan's own; null for everyone else.
ALTER TABLE organizations ADD COLUMN limits_override TEXT;
-- subscription_status, current_period_end and billing_event_at (0031) stay as they are.
CREATE UNIQUE INDEX organizations_billing_subscription_idx ON organizations (billing_provider, billing_subscription_id)
  WHERE billing_subscription_id IS NOT NULL;
