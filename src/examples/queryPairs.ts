import { ExampleQueryPair } from "../types.js";

export const exampleQueryPairs: ExampleQueryPair[] = [
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
];
