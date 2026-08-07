"use client";

/** 두 테이블 사이 컬럼 페어 후보 — 점수 순 목록 + 수동 지정 드롭다운.
 * Scored column-pair candidates, with a manual fallback for pairs the scorer misses. */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { fetchObjectDetail, fetchPairCandidates, type ObjectDetail, type PairCandidate } from "@/lib/api";

interface PairCandidateListProps {
  srcObjectId: number;
  tgtObjectId: number;
  selectedPair: PairCandidate | null;
  onPick: (pair: PairCandidate) => void;
}

type DetailColumn = ObjectDetail["columns"][number];

/** 수동 선택은 점수·신호가 없다 — 0/{}으로 채워 후보와 같은 모양을 유지한다. */
function buildManualPair(src: DetailColumn, tgt: DetailColumn): PairCandidate {
  return {
    src_column_id: src.id, src_column: src.name, src_data_type: src.data_type,
    tgt_column_id: tgt.id, tgt_column: tgt.name, tgt_data_type: tgt.data_type,
    tgt_is_pk: tgt.is_pk, score: 0, signals: {},
  };
}

export function PairCandidateList({
  srcObjectId, tgtObjectId, selectedPair, onPick,
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

  // 드롭다운은 선택된 페어를 그대로 비춘다 — 후보를 눌러도 같은 값이 표시된다
  const manualSrcId = selectedPair?.src_column_id ?? null;
  const manualTgtId = selectedPair?.tgt_column_id ?? null;

  const handleManualChange = (side: "src" | "tgt", columnId: number) => {
    const src = side === "src"
      ? srcColumns.find((c) => c.id === columnId)
      : srcColumns.find((c) => c.id === manualSrcId);
    const tgt = side === "tgt"
      ? tgtColumns.find((c) => c.id === columnId)
      : tgtColumns.find((c) => c.id === manualTgtId);
    if (!src || !tgt) return; // 한쪽만 고른 상태 — 나머지를 고를 때 페어가 완성된다
    onPick(buildManualPair(src, tgt));
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
            value={manualSrcId ?? ""}
            onChange={(e) => handleManualChange("src", Number(e.target.value))}
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
            value={manualTgtId ?? ""}
            onChange={(e) => handleManualChange("tgt", Number(e.target.value))}
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
