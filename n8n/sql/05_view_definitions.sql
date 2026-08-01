-- 뷰 DDL / view definitions → catalog.json view_definitions[]
-- 반드시 sys.sql_modules 사용 — INFORMATION_SCHEMA.VIEWS는 4000자에서 절단된다
-- MUST use sys.sql_modules; INFORMATION_SCHEMA.VIEWS truncates at 4000 chars
-- definition IS NULL = VIEW DEFINITION 권한 차단 (에러가 아니라 조용한 NULL — 정찰 쿼리 [3]으로 선확인)
SELECT v.object_id,
       m.definition
FROM sys.views v
LEFT JOIN sys.sql_modules m ON v.object_id = m.object_id;
