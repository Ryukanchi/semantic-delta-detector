import { ExampleQueryPair } from "../types.js";

export const exampleQueryPairs: ExampleQueryPair[] = [
  {
    id: "same-de-users-formatting",
    title: "Same DE Users With Formatting Changes",
    description: "Shows that formatting-only SQL changes do not create semantic risk.",
    queryAName: "de_users",
    queryBName: "de_users",
    queryA: "SELECT COUNT(*) FROM users WHERE country = 'DE'",
    queryB: `SELECT COUNT(*)
FROM users
WHERE country = 'DE'`,
  },
  {
    id: "login-vs-paid",
    title: "Engaged Users vs Paying Users",
    description: "Shows two distinct-count metrics that look structurally similar but mean different things.",
    queryAName: "engaged_users",
    queryBName: "paying_users",
    queryA: `SELECT COUNT(DISTINCT user_id)
FROM events
WHERE event = 'login'
AND event_date >= CURRENT_DATE - INTERVAL '30 days'`,
    queryB: `SELECT COUNT(DISTINCT user_id)
FROM users
WHERE subscription_status = 'paid'
AND last_active >= CURRENT_DATE - INTERVAL '30 days'`,
  },
  {
    id: "signups-vs-activated",
    title: "New Signups vs Activated Accounts",
    description: "Highlights the difference between acquisition and activation metrics.",
    queryAName: "new_signups",
    queryBName: "activated_accounts",
    queryA: `SELECT COUNT(DISTINCT user_id)
FROM users
WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`,
    queryB: `SELECT COUNT(DISTINCT user_id)
FROM users
WHERE activated_at >= CURRENT_DATE - INTERVAL '7 days'
AND onboarding_status = 'completed'`,
  },
  {
    id: "unique-login-users-vs-login-event-rows",
    title: "Unique Login Users vs Login Event Rows",
    description: "Shows a counted-unit change from unique users to event rows.",
    queryAName: "unique_login_users",
    queryBName: "login_event_rows",
    queryA: "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
    queryB: "SELECT COUNT(*) FROM events WHERE event = 'login'",
  },
  {
    id: "paid-users-vs-all-users",
    title: "Paid Users vs All Users",
    description: "Shows how removing a paid-plan filter changes the metric population.",
    queryAName: "paid_users",
    queryBName: "all_users",
    queryA: "SELECT COUNT(*) FROM users WHERE plan = 'paid'",
    queryB: "SELECT COUNT(*) FROM users",
  },
  {
    id: "daily-login-counts-vs-monthly-login-counts",
    title: "Daily Login Counts vs Monthly Login Counts",
    description: "Shows a reporting-grain change from daily to monthly login counts.",
    queryAName: "daily_login_counts",
    queryBName: "monthly_login_counts",
    queryA: "SELECT DATE(created_at), COUNT(*) FROM events WHERE event = 'login' GROUP BY DATE(created_at)",
    queryB:
      "SELECT DATE_TRUNC('month', created_at), COUNT(*) FROM events WHERE event = 'login' GROUP BY DATE_TRUNC('month', created_at)",
  },
  {
    id: "left-join-vs-inner-join",
    title: "LEFT JOIN vs INNER JOIN",
    description: "Shows how changing join type can exclude users without matching orders.",
    queryAName: "users_with_optional_orders",
    queryBName: "users_with_orders",
    queryA: "SELECT COUNT(*) FROM users u LEFT JOIN orders o ON u.id = o.user_id",
    queryB: "SELECT COUNT(*) FROM users u JOIN orders o ON u.id = o.user_id",
  },
];
