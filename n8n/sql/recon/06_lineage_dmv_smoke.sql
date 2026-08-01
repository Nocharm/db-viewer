-- [6] lineage DMV 스모크 테스트 / dm_sql_referenced_entities smoke test
-- 대상 뷰 1개를 골라 즉시 호출 — 권한·호환성 문제를 미리 드러낸다
-- pick one view and call the DMV inline; surfaces permission issues early
DECLARE @qname nvarchar(517);
SELECT TOP 1 @qname = QUOTENAME(s.name) + N'.' + QUOTENAME(v.name)
FROM sys.views v
JOIN sys.schemas s ON v.schema_id = s.schema_id
ORDER BY v.object_id;

IF @qname IS NULL
    SELECT CAST(NULL AS nvarchar(517)) AS smoke_view, 'no views found' AS note;
ELSE
BEGIN TRY
    SELECT @qname AS smoke_view,
           COUNT(*) AS referenced_rows,
           CAST(NULL AS nvarchar(400)) AS error
    FROM sys.dm_sql_referenced_entities(@qname, 'OBJECT');
END TRY
BEGIN CATCH
    SELECT @qname AS smoke_view,
           CAST(NULL AS int) AS referenced_rows,
           LEFT(ERROR_MESSAGE(), 400) AS error;
END CATCH;
