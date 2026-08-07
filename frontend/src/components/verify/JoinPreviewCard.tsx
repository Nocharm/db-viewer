"use client";

/** 확정 직전 눈으로 확인하는 카드 — 조인 샘플과 양쪽 테이블 원본 샘플.
 * The last look before confirming: a join sample plus each side's raw rows. */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { fetchObjectPreview, runValidatePreview } from "@/lib/api";

interface JoinPreviewCardProps {
  srcColumnId: number;
  tgtColumnId: number;
  /** 양쪽 스키마가 모두 미리보기 허용 목록에 있는가 — 서버도 403으로 다시 막는다 */
  allowed: boolean;
  srcObjectId: number;
  tgtObjectId: number;
}

interface SampleView {
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  masked: string[];
}

/** 행 JSON이 키-동질적이라는 보장이 없다 — 등장 순서대로 전 행에서 합친다.
 * Row JSON isn't guaranteed key-homogeneous; union across rows in first-seen order. */
function buildColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

// 좌우 원본 샘플 행수 — 화면 확인용이라 조인 샘플(서버 기본)보다 넉넉히 본다
const SAMPLE_LIMIT = 200;

export function JoinPreviewCard({
  srcColumnId, tgtColumnId, allowed, srcObjectId, tgtObjectId,
}: JoinPreviewCardProps) {
  const { t } = useI18n();
  const [view, setView] = useState<SampleView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 페어가 바뀌면 이전 페어의 원본 값이 화면에 남지 않게 지운다 — 오귀속 방지
  useEffect(() => {
    setView(null);
    setError(null);
  }, [srcColumnId, tgtColumnId]);

  const load = (request: Promise<SampleView>) => {
    setBusy(true);
    setError(null);
    request
      .then(setView)
      .catch((e: Error) => {
        setError(e.message);
        setView(null);
      })
      .finally(() => setBusy(false));
  };

  const handleJoin = () => load(
    runValidatePreview(srcColumnId, tgtColumnId).then((res) => ({
      title: `${res.src} ⋈ ${res.tgt}`,
      columns: buildColumns(res.rows),
      rows: res.rows,
      masked: res.masked_columns,
    })),
  );

  const handleSample = (objectId: number) => load(
    fetchObjectPreview(objectId, undefined, SAMPLE_LIMIT).then((res) => ({
      title: res.object,
      columns: res.columns,
      rows: res.rows,
      masked: res.masked_columns,
    })),
  );

  return (
    <section className="card p-4" data-testid="JoinPreviewCard-root">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t("verify.preview.title")}
        </span>
        <button className="btn-secondary ml-auto !py-1 text-xs"
                disabled={!allowed || busy} onClick={handleJoin}
                data-testid="JoinPreviewCard-joinButton">
          {t("verify.preview.join")}
        </button>
        <button className="btn-secondary !py-1 text-xs"
                disabled={!allowed || busy} onClick={() => handleSample(srcObjectId)}
                data-testid="JoinPreviewCard-srcSampleButton">
          {t("verify.srcTitle")} {t("verify.preview.sample")}
        </button>
        <button className="btn-secondary !py-1 text-xs"
                disabled={!allowed || busy} onClick={() => handleSample(tgtObjectId)}
                data-testid="JoinPreviewCard-tgtSampleButton">
          {t("verify.tgtTitle")} {t("verify.preview.sample")}
        </button>
      </div>

      {!allowed && (
        <p className="text-sm" style={{ color: "var(--slate)" }}
           data-testid="JoinPreviewCard-notAllowed">
          {t("verify.preview.notAllowed")}
        </p>
      )}

      {allowed && busy && (
        <p className="text-sm" style={{ color: "var(--muted)" }}
           data-testid="JoinPreviewCard-busy">
          {t("common.loading")}
        </p>
      )}

      {allowed && !busy && error && (
        <p className="text-sm" style={{ color: "var(--error)" }}
           data-testid="JoinPreviewCard-errorText">
          {error}
        </p>
      )}

      {allowed && !busy && view && (
        <div data-testid="JoinPreviewCard-rows">
          <div className="mb-1 font-mono text-xs" style={{ color: "var(--slate)" }}>
            {view.title} · {view.rows.length}
            {t("preview.rowsSuffix")}
          </div>
          {view.rows.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>{t("join.previewEmpty")}</p>
          ) : (
            <div className="scroll-area max-h-64 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    {view.columns.map((c) => (
                      <th key={c} className="px-2 py-1 text-left font-mono"
                          style={{ color: "var(--muted)" }}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row, i) => (
                    // 인덱스 키가 안전하다 — 조회마다 목록을 통째로 갈아끼우고, 안에서
                    // 재정렬·삽입·삭제가 없다 / whole list is replaced per fetch, never mutated in place
                    <tr key={i}>
                      {view.columns.map((c) => (
                        // null/undefined는 빈 문자열 — "undefined" 글자가 값처럼 보이지 않게
                        <td key={c} className="px-2 py-1 font-mono">{String(row[c] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view.masked.length > 0 && (
            <p className="mt-1 text-xs" style={{ color: "var(--slate)" }}>
              {t("join.previewMasked").replace("{cols}", view.masked.join(", "))}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
