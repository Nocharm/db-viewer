-- 컬럼 수준 lineage / column-grain deps → view_deps.json deps[] (2차) + unresolved_objects[]
-- ⚠ 객체별 개별 호출 필수 — 일괄 CROSS APPLY는 해석 불가 객체 "하나"로 전체가 실패한다
-- ⚠ per-object calls only; one unresolvable object kills a batched CROSS APPLY
-- 이 DMV는 "뷰가 참조하는 컬럼 집합"만 제공 — 출력 컬럼별 1:1 매핑은 Phase 2 (sqlglot)
DECLARE @results TABLE (
    view_object_id int, referenced_object_id int NULL, referenced_database sysname NULL,
    referenced_name nvarchar(517) NULL, referenced_column sysname NULL, is_resolved bit
);
DECLARE @failures TABLE (object_id int, reason nvarchar(400));
DECLARE @oid int, @qname nvarchar(517);

DECLARE view_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT v.object_id, QUOTENAME(s.name) + N'.' + QUOTENAME(v.name)
    FROM sys.views v
    JOIN sys.schemas s ON v.schema_id = s.schema_id;

OPEN view_cursor;
FETCH NEXT FROM view_cursor INTO @oid, @qname;
WHILE @@FETCH_STATUS = 0
BEGIN
    BEGIN TRY
        INSERT INTO @results
        SELECT @oid,
               r.referenced_id,
               r.referenced_database_name,
               ISNULL(r.referenced_schema_name + '.', '') + r.referenced_entity_name,
               r.referenced_minor_name,
               CASE WHEN r.referenced_id IS NULL THEN 0 ELSE 1 END
        FROM sys.dm_sql_referenced_entities(@qname, 'OBJECT') r
        WHERE r.referenced_minor_name IS NOT NULL OR r.referenced_id IS NULL;
    END TRY
    BEGIN CATCH
        -- 실패 객체는 격리하고 계속 진행 / isolate the failing object, keep going
        INSERT INTO @failures VALUES (@oid, LEFT(ERROR_MESSAGE(), 400));
    END CATCH;
    FETCH NEXT FROM view_cursor INTO @oid, @qname;
END
CLOSE view_cursor;
DEALLOCATE view_cursor;

-- n8n MSSQL 노드는 단일 rowset만 반환 → kind 컬럼으로 두 결과를 합친다
-- n8n's MSSQL node returns a single rowset; merge both with a kind discriminator
SELECT 'dep' AS kind, view_object_id, referenced_object_id, referenced_database,
       referenced_name, referenced_column, is_resolved,
       CAST(NULL AS nvarchar(400)) AS reason
FROM @results
UNION ALL
SELECT 'failure', object_id, NULL, NULL, NULL, NULL, NULL, reason
FROM @failures;
