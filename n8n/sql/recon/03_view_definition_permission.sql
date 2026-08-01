-- [3] 뷰 DDL 권한 / VIEW DEFINITION permission  ★ 최우선
-- blocked > 0 이면 권한 부족 — 에러가 아니라 조용히 NULL이라 놓치기 쉽다
-- blocked > 0 means missing permission; fails silently as NULL, not an error
SELECT COUNT(*) AS total,
       SUM(CASE WHEN m.definition IS NULL THEN 1 ELSE 0 END) AS blocked
FROM sys.views v
LEFT JOIN sys.sql_modules m ON v.object_id = m.object_id;
