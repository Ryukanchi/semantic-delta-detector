SELECT COUNT(DISTINCT user_id)
FROM events
WHERE event = 'login'
AND event_date >= CURRENT_DATE - INTERVAL '30 days';
