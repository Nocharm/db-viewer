"use client";

/** 확정 직전 눈으로 확인하는 카드 — 조인 샘플과 양쪽 테이블 원본 샘플.
 * The last look before confirming: a join sample plus each side's raw rows. */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { SampleIcon } from "@/components/icons";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import { fetchObjectPreview, runValidatePreview } from "@/lib/api";

interface JoinPreviewCardProps {
  /** 좌측 진행 순서에서 이동해 오는 앵커 / anchor for the step navigator */
  id: string;
  srcColumnId: number;
  tgtColumnId: number;
  /** 양쪽 스키마가 모두 미리보기 허용 목록에 있는가 — 서버도 403으로 다시 막는다 */
  allowed: boolean;
  srcObjectId: number;
  tgtObjectId: number;
  /** 샘플을 한 번이라도 본 시점 — 흐름 다이어그램의 3단계 완료 표시용 */
  onViewed?: () => void;
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
  id, srcColumnId, tgtColumnId, allowed, srcObjectId, tgtObjectId, onViewed,
}: JoinPreviewCardProps) {
  const { t } = useI18n();
  const [view, setView] = useState<SampleView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 최신 요청 표식 — 이 값과 다른 응답은 버린다 (페어 변경·연속 클릭 모두 무효화한다)
  // marks the newest request; anything else resolving is a stale result and gets dropped
  const requestIdRef = useRef(0);

  // 페어가 바뀌면 이전 페어의 원본 값이 화면에 남지 않게 지우고, 인플라이트 응답도 무효화한다
  // — 값이 그대로 되살아나면 다른 페어의 행을 지금 페어의 것으로 오귀속하게 된다
  useEffect(() => {
    requestIdRef.current += 1;
    setView(null);
    setError(null);
    setBusy(false);
  }, [srcColumnId, tgtColumnId]);

  const load = (request: Promise<SampleView>) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setBusy(true);
    setError(null);
    request
      .then((next) => {
        if (requestId !== requestIdRef.current) return;
        setView(next);
        onViewed?.();
      })
      .catch((e: Error) => {
        if (requestId !== requestIdRef.current) return;
        setError(e.message);
        setView(null);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setBusy(false);
      });
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
    <section id={id} className="card p-4" data-testid="JoinPreviewCard-root">
      {/* 버튼 군은 제목 옆 — ml-auto 우측 밀착은 제목과의 거리만 벌린다 (GateCard와 동일) */}
      <StepCardHeader
        no={3}
        icon={<SampleIcon size={15} />}
        title={t("verify.preview.title")}
        desc={t("verify.step3.desc")}
        lockNote={allowed ? null : t("verify.preview.notAllowed")}
        done={view !== null}
      >
        <button className="btn-secondary !py-1 text-xs"
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
      </StepCardHeader>

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
