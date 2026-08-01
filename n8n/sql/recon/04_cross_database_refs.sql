-- [4] 크로스 DB 참조 / cross-database references — 카탈로그가 못 잡는 유일한 경로(Phase 2)
SELECT DISTINCT referenced_database_name
FROM sys.sql_expression_dependencies
WHERE referenced_database_name IS NOT NULL;
