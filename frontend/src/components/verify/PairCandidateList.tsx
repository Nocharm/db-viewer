"use client";

/** 두 테이블 사이 컬럼 페어 후보 — 점수 순 목록 + 수동 지정 드롭다운.
 * Scored column-pair candidates, with a manual fallback for pairs the scorer misses. */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { fetchObjectDetail, fetchPairCandidates, type ObjectDetail, type PairCandidate } from "@/lib/api";
import { applyManualSelection, buildManualPair, toManualSelection } from "@/lib/verify-pair";

interface PairCandidateListProps {
  srcObjectId: number;
  tgtObjectId: number;
  selectedPair: PairCandidate | null;
  onPick: (pair: PairCandidate) => void;
  /** 딥링크가 src 컬럼만 싣고 tgt를 못 정했을 때의 수동 선택 초기값(src쪽만) */
  initialManualSrcColumnId?: number | null;
}

type DetailColumn = ObjectDetail["columns"][number];

export function PairCandidateList({
  srcObjectId, tgtObjectId, selectedPair, onPick, initialManualSrcColumnId = null,
}: PairCandidateListProps) {
  const { t } = useI18n();
  const [items, setItems] = useState<PairCandidate[]>([]);
  const [srcColumns, setSrcColumns] = useState<DetailColumn[]>([]);
  const [tgtColumns, setTgtColumns] = useState<DetailColumn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchPairCandidates(srcObjectId, tgtObjectId),
      fetchObjectDetail(srcObjectId),
      fetchObjectDetail(tgtObjectId),
    ])
      .then(([candidates, srcDetail, tgtDetail]) => {
        if (cancelled) return;
        setItems(candidates.items);
        setSrcColumns(srcDetail.columns);
        setTgtColumns(tgtDetail.columns);
        setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [srcObjectId, tgtObjectId]);

  // 반쪽 선택은 여기 산다 — 페어가 완성되기 전에는 부모(selectedPair)가 담을 수 없다
  // the half-picked state lives here: the parent's pair can't represent "one side chosen"
  // src만 실은 딥링크(tgt 미정)는 이 초기값으로 들어온다 — 마운트 시 한 번만 반영
  const [manual, setManual] = useState(() => (
    initialManualSrcColumnId !== null
      ? { srcColumnId: initialManualSrcColumnId, tgtColumnId: null }
      : toManualSelection(selectedPair)
  ));

  // 후보 클릭·딥링크로 페어가 바뀌면 드롭다운도 그 페어를 가리킨다 — null로는 되돌리지
  // 않는다(그러면 마운트 직후 위의 초기 seed를 이 effect가 곧바로 지워버린다)
  useEffect(() => {
    if (selectedPair) setManual(toManualSelection(selectedPair));
  }, [selectedPair]);

  const handleManualChange = (side: "src" | "tgt", columnId: number | null) => {
    const next = applyManualSelection(manual, side, columnId);
    setManual(next);
    const pair = buildManualPair(next, srcColumns, tgtColumns);
    if (pair) onPick(pair); // 나머지 한 쪽이 채워지는 순간 페어가 선다
  };

  return (
    <section className="card p-3" data-testid="PairCandidateList-root">
      <div className="mb-2 text-xs font-semibold uppercase tracking-widest"
           style={{ color: "var(--muted)" }}>
        {t("verify.candidates.title")}
      </div>

      {error && (
        <p className="text-xs" style={{ color: "var(--error)" }}
           data-testid="PairCandidateList-errorText">
          {error}
        </p>
      )}
      {loading && (
        <p className="text-xs" style={{ color: "var(--muted)" }}
           data-testid="PairCandidateList-loading">
          {t("common.loading")}
        </p>
      )}

      <ul className="scroll-area max-h-64 overflow-y-auto"
          data-testid="PairCandidateList-items">
        {items.map((item) => {
          const active = selectedPair?.src_column_id === item.src_column_id
            && selectedPair?.tgt_column_id === item.tgt_column_id;
          return (
            <li key={`${item.src_column_id}-${item.tgt_column_id}`}>
              <button
                className="w-full rounded px-2 py-1.5 text-left hover:bg-[var(--soft-stone)]"
                style={active ? { background: "var(--soft-stone)" } : undefined}
                onClick={() => onPick(item)}
                data-testid={`PairCandidateList-item-${item.src_column_id}-${item.tgt_column_id}`}
              >
                <span className="font-mono text-xs">
                  {item.src_column} = {item.tgt_column}
                </span>
                <span className="float-right font-mono text-xs" style={{ color: "var(--stat-ink)" }}>
                  {item.score.toFixed(2)}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1">
                  {item.tgt_is_pk && <span className="badge badge--confirmed">PK</span>}
                  {Object.entries(item.signals)
                    .filter(([, value]) => value > 0)
                    .map(([name]) => (
                      <span key={name} className="badge badge--muted">{name}</span>
                    ))}
                </span>
              </button>
            </li>
          );
        })}
        {!loading && items.length === 0 && !error && (
          <li className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}
              data-testid="PairCandidateList-emptyState">
            {t("verify.candidates.empty")}
          </li>
        )}
      </ul>

      <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
        <div className="mb-1 text-xs" style={{ color: "var(--muted)" }}>
          {t("verify.candidates.manual")}
        </div>
        <div className="flex items-center gap-1">
          <select
            className="min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs"
            style={{ borderColor: "var(--border-light)" }}
            value={manual.srcColumnId ?? ""}
            onChange={(e) => handleManualChange("src", e.target.value ? Number(e.target.value) : null)}
            data-testid="PairCandidateList-srcColumnSelect"
          >
            <option value="">—</option>
            {srcColumns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <span style={{ color: "var(--muted)" }}>=</span>
          <select
            className="min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs"
            style={{ borderColor: "var(--border-light)" }}
            value={manual.tgtColumnId ?? ""}
            onChange={(e) => handleManualChange("tgt", e.target.value ? Number(e.target.value) : null)}
            data-testid="PairCandidateList-tgtColumnSelect"
          >
            <option value="">—</option>
            {tgtColumns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
