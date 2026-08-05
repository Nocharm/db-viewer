-- 객체·뷰 총수 / totals — 서비스가 페이지 수를 산출한다
SELECT
  (SELECT COUNT(*) FROM sys.objects WHERE type IN ('U', 'V')) AS object_total,
  (SELECT COUNT(*) FROM sys.views) AS view_total;
