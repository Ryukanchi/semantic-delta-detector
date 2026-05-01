# Show HN Draft

## Possible Title

Show HN: Semantic Delta - a heuristic SQL diff tool for metric meaning changes

## Short Launch Text

Hi HN,

I built Semantic Delta, a small TypeScript semantic risk engine for SQL metric changes.

The idea is to catch SQL edits that look harmless in a code diff but can quietly change what a KPI means. For example, changing `COUNT(DISTINCT user_id)` to `COUNT(*)`, removing a paid-user filter, or changing a `LEFT JOIN` to an `INNER JOIN`.

It is an MVP and intentionally heuristic. It is not a SQL validator, not a metric governance platform, and not a source of truth. Right now it focuses on flagging likely semantic drift early enough that a human reviewer can ask the right question.

GitHub: `https://github.com/Ryukanchi/semantic-delta-detector`

## Problem It Solves

Normal diffs show that SQL changed. They do not always make it obvious that the business meaning changed.

That matters when dashboards, experiments, revenue reports, or operational metrics depend on stable definitions. A query can keep the same metric name while switching from users to events, paid users to all users, daily reporting to monthly reporting, or optional joins to required joins.

Semantic Delta tries to turn those changes into a compact risk report with evidence and a reviewer recommendation.

## Feedback Wanted

I would especially appreciate feedback from people who review analytics SQL, dbt models, BI metric definitions, or product/finance dashboards:

- Which SQL metric changes have caused real confusion on your team?
- Are the current risk categories useful, too noisy, or missing important cases?
- What examples would make this more credible as a reviewer aid?
- Would local PR simulation and optional CI severity gating fit your workflow?

The goal is not to block every SQL change. The goal is to make silent KPI drift easier to notice before it reaches a dashboard.
