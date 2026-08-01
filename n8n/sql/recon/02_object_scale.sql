-- [2] 객체 규모 / object scale — 계획 전제(테이블 409)와의 차이 확인
SELECT type_desc, COUNT(*) AS cnt
FROM sys.objects
WHERE type IN ('U', 'V')
GROUP BY type_desc;
