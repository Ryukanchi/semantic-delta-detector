export const fixtures = {
  happyPath: {
    inputA: {
      query: `SELECT COUNT(DISTINCT user_id)
FROM users
WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`,
    },
    inputB: {
      query: `SELECT COUNT(DISTINCT user_id)
FROM users
WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`,
    },
  },
  semanticMismatch: {
    inputA: {
      query: `SELECT COUNT(DISTINCT user_id)
FROM events
WHERE event = 'login'
AND event_date >= CURRENT_DATE - INTERVAL '30 days'`,
    },
    inputB: {
      query: `SELECT COUNT(DISTINCT user_id)
FROM users
WHERE subscription_status = 'paid'
AND last_active >= CURRENT_DATE - INTERVAL '30 days'`,
    },
  },
  aliasEdgeCase: {
    inputA: {
      query: `SELECT COUNT(DISTINCT u.user_id)
FROM users AS u
WHERE u.created_at >= CURRENT_DATE - INTERVAL '7 days'`,
    },
    inputB: {
      query: `SELECT COUNT(DISTINCT user_id)
FROM users
WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`,
    },
  },
  metadataMismatch: {
    inputA: {
      metric_name: "active_users",
      team_context: "product",
      description: "Users who logged in during the last 30 days",
      intended_use: "product dashboard",
      query: `SELECT COUNT(DISTINCT user_id)
FROM events
WHERE event = 'login'
AND event_date >= CURRENT_DATE - INTERVAL '30 days'`,
    },
    inputB: {
      metric_name: "active_users",
      team_context: "finance",
      description: "Paying users who were recently active in the last 30 days",
      intended_use: "executive revenue reporting",
      query: `SELECT COUNT(DISTINCT user_id)
FROM users
WHERE subscription_status = 'paid'
AND last_active >= CURRENT_DATE - INTERVAL '30 days'`,
    },
  },
} as const;
