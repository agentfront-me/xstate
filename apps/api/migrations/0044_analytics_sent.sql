-- xstate's own analytics (docs/analytics-events.md): money events already sent, so a webhook Paddle delivers twice
-- never counts a payment or refund twice. key is e.g. 'paddle:txn_…:completed'. Safe to prune after a few weeks.
CREATE TABLE analytics_sent (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
