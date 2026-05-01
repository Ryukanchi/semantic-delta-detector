# Reddit Feedback Draft

## Title Options

- I built a heuristic SQL diff tool to catch metric meaning changes. Looking for feedback from data teams.
- Feedback wanted: detecting SQL changes that silently alter KPI meaning
- How would your team review `COUNT(DISTINCT user_id)` changing to `COUNT(*)`?

## Body

Hi all,

I am working on an MVP called Semantic Delta. It is a TypeScript semantic risk engine for SQL metric changes.

The goal is modest: catch SQL edits that look reasonable in a normal diff but may change the meaning of a dashboard metric or KPI. It is heuristic, so I am not treating it as a source of truth. I am trying to understand whether the warnings match the kinds of problems data teams actually run into.

I am especially interested in real examples where a harmless-looking SQL review later changed how a dashboard was interpreted.

Some examples it is designed to flag:

### Example 1: Unique users vs event rows

```sql
-- Query A
SELECT COUNT(DISTINCT user_id)
FROM events
WHERE event = 'login';
```

```sql
-- Query B
SELECT COUNT(*)
FROM events
WHERE event = 'login';
```

This can change the metric from "unique users who logged in" to "login event rows." If users can log in multiple times, those are not interchangeable.

### Example 2: Paid users vs all users

```sql
-- Query A
SELECT COUNT(*)
FROM users
WHERE plan = 'paid';
```

```sql
-- Query B
SELECT COUNT(*)
FROM users;
```

This changes the population behind the metric. That might be intentional, but it should probably be called out during review.

### Example 3: LEFT JOIN vs INNER JOIN

```sql
-- Query A
SELECT COUNT(*)
FROM users u
LEFT JOIN orders o ON u.id = o.user_id;
```

```sql
-- Query B
SELECT COUNT(*)
FROM users u
JOIN orders o ON u.id = o.user_id;
```

This can exclude users without matching orders, changing the population being counted.

Today the project can produce a Verdict + Impact report, format a PR-style comment locally, run a local PR simulation, and preview the behavior in GitHub Actions logs. It does not post real GitHub PR comments yet.

I would love feedback on:

- What SQL metric changes would you most want detected?
- Which warnings would be helpful vs noisy?
- Are there common dbt / warehouse / BI patterns this kind of tool should understand first?
- Would optional CI severity gating be useful, or would it be too blunt for analytics work?

I am trying to keep this practical and reviewer-focused rather than turn it into a heavy governance system. Any examples from real data review pain would be very helpful.
