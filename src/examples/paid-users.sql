SELECT COUNT(DISTINCT user_id)
FROM users
WHERE subscription_status = 'paid'
AND last_active >= CURRENT_DATE - INTERVAL '30 days';
