-- 객체 총수 / total object count — 분할 수집의 청크 수 산출용 (W1a)
-- 창(window) 쿼리와 같은 필터를 써야 청크 경계가 어긋나지 않는다
SELECT COUNT(*) AS object_total
FROM sys.objects
WHERE type IN ('U', 'V');
