# Demo Cases

Compact examples for showing the kinds of semantic changes Semantic Delta is meant to flag.

## Unique Login Users vs Login Event Rows

Query A:

```sql
SELECT COUNT(DISTINCT user_id)
FROM events
WHERE event = 'login';
```

Query B:

```sql
SELECT COUNT(*)
FROM events
WHERE event = 'login';
```

Expected risk: high

Why it matters: changes the counted unit from unique users to event rows. Repeat logins can inflate the metric.

## Paid Users vs All Users

Query A:

```sql
SELECT COUNT(*)
FROM users
WHERE plan = 'paid';
```

Query B:

```sql
SELECT COUNT(*)
FROM users;
```

Expected risk: high

Why it matters: removes a monetization filter and changes the population from paying users to all users.

## Daily vs Monthly Logins

Query A:

```sql
SELECT DATE(created_at), COUNT(*)
FROM events
WHERE event = 'login'
GROUP BY DATE(created_at);
```

Query B:

```sql
SELECT DATE_TRUNC('month', created_at), COUNT(*)
FROM events
WHERE event = 'login'
GROUP BY DATE_TRUNC('month', created_at);
```

Expected risk: medium

Why it matters: keeps the same activity concept but changes the reporting grain. Daily and monthly points should not be compared as the same KPI shape.

## LEFT JOIN vs INNER JOIN

Query A:

```sql
SELECT COUNT(*)
FROM users u
LEFT JOIN orders o ON u.id = o.user_id;
```

Query B:

```sql
SELECT COUNT(*)
FROM users u
JOIN orders o ON u.id = o.user_id;
```

Expected risk: high

Why it matters: changing from an optional relationship to a required relationship can exclude users without matching orders.

## Low-Risk Formatting-Only Case

Query A:

```sql
SELECT COUNT(*)
FROM users
WHERE country = 'DE';
```

Query B:

```sql
SELECT
  COUNT(*)
FROM users
WHERE country = 'DE';
```

Expected risk: low

Why it matters: formatting-only edits should not create semantic warnings. Low-risk equivalence handling helps keep review output useful.
