"use client";

/** 1:1 조인 검증 화면 — 테이블 두 개 → 컬럼 페어 → 게이트 → 포함률 → 확정.
 * The 1:1 join verification flow: two tables, a column pair, gate, containment, confirm. */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { useI18n } from "@/components/i18n";
import { ContainmentCard } from "@/components/verify/ContainmentCard";
import { GateCard } from "@/components/verify/GateCard";
import { JoinPreviewCard } from "@/components/verify/JoinPreviewCard";
import { PairCandidateList } from "@/components/verify/PairCandidateList";
import { PendingList } from "@/components/verify/PendingList";
import { TablePickerPanel } from "@/components/verify/TablePickerPanel";
import {
  confirmRelation, fetchObjectDetail, runContainment, runGate, searchObjects,
  type PairCandidate, type PendingRelation,
} from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";
import { usePreviewAllowlist } from "@/lib/use-preview-allowlist";
import { isSamePair } from "@/lib/verify-pair";
import {
  applyConfirm, applyContainment, applyGateResult, canConfirm, canRunContainment,
  createInitialState, resetForNewPair, type VerifyState,
} from "@/lib/verify-flow";

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyPageInner />
    </Suspense>
  );
}

/** "schema.name" + id → 목록 항목 모양 / rebuilds a list entry from a qualified name. */
function objectFromQname(id: number, qname: string): ObjectSummary | null {
  if (!qname.includes(".")) return null;
  const [schema, name] = qname.split(".", 2);
  return {
    id, schema, name, type: "table",
    row_count: null, column_count: 0, dmv_unresolved: false,
  };
}

/** id가 없으면 이름으로 검색해 해석한다 — 딥링크는 label만 실어 보낼 수 있다.
 * Deep links may carry only the label, so fall back to a name search. */
async function resolveSide(
  idParam: string | null, labelParam: string | null,
): Promise<ObjectSummary | null> {
  if (!labelParam || !labelParam.includes(".")) return null;
  if (idParam) return objectFromQname(Number(idParam), labelParam);
  // 검색 q는 이름만 매칭한다(스키마 접두어는 안 먹는다) — 이름으로 찾고 qname으로 확정
  const [, name] = labelParam.split(".", 2);
  const res = await searchObjects(name, "table");
  return res.items.find((o) => `${o.schema}.${o.name}` === labelParam) ?? null;
}

function VerifyPageInner() {
  const { t } = useI18n();
  const params = useSearchParams();
  const previewAllowed = usePreviewAllowlist();
  const [src, setSrc] = useState<ObjectSummary | null>(null);
  const [tgt, setTgt] = useState<ObjectSummary | null>(null);
  const [pair, setPair] = useState<PairCandidate | null>(null);
  const [state, setState] = useState<VerifyState>(createInitialState);
  const [gateBusy, setGateBusy] = useState(false);
  const [containmentBusy, setContainmentBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 확정하면 대기 큐에서 내려간다 — 값을 올려 PendingList에 재조회를 지시
  const [pendingRefresh, setPendingRefresh] = useState(0);

  // 인플라이트 응답을 적용할지 가리는 기준 — 늦게 온 이전 페어의 결과는 버린다
  // the yardstick for late results: anything from a pair we've left is dropped
  const pairRef = useRef<PairCandidate | null>(null);
  useEffect(() => {
    pairRef.current = pair;
  }, [pair]);

  // 페어를 떠나면 그 페어의 요청은 더 이상 busy를 풀어주지 않는다 — 여기서 직접 푼다
  const clearBusy = useCallback(() => {
    setGateBusy(false);
    setContainmentBusy(false);
    setConfirmBusy(false);
  }, []);

  const handlePickPair = useCallback((next: PairCandidate) => {
    setPair(next);
    setState(resetForNewPair());
    setError(null);
    clearBusy();
  }, [clearBusy]);

  const handleSelectSide = (side: "src" | "tgt", obj: ObjectSummary | null) => {
    if (side === "src") setSrc(obj);
    else setTgt(obj);
    setPair(null);
    setState(resetForNewPair());
    setError(null);
    clearBusy();
  };

  // URL 프리필 — /verify?src=&srcLabel=&srcCol=&tgt=&tgtLabel=&tgtCol= (전부 선택적)
  // 라우트 안에서 쿼리만 바뀌는 딥링크(리마운트 없음)도 받도록 params를 직접 구독한다
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [nextSrc, nextTgt] = await Promise.all([
        resolveSide(params.get("src"), params.get("srcLabel")),
        resolveSide(params.get("tgt"), params.get("tgtLabel")),
      ]);
      if (cancelled) return;
      if (nextSrc) setSrc((cur) => (cur?.id === nextSrc.id ? cur : nextSrc));
      if (nextTgt) setTgt((cur) => (cur?.id === nextTgt.id ? cur : nextTgt));

      const srcCol = params.get("srcCol");
      const tgtCol = params.get("tgtCol");
      if (!srcCol || !tgtCol || !nextSrc || !nextTgt) return;
      // 컬럼 id만으로는 이름·타입을 모른다 — 상세에서 메타를 채워 페어를 완성한다
      const [srcDetail, tgtDetail] = await Promise.all([
        fetchObjectDetail(nextSrc.id), fetchObjectDetail(nextTgt.id),
      ]);
      if (cancelled) return;
      const srcColumn = srcDetail.columns.find((c) => c.id === Number(srcCol));
      const tgtColumn = tgtDetail.columns.find((c) => c.id === Number(tgtCol));
      if (!srcColumn || !tgtColumn) return;
      handlePickPair({
        src_column_id: srcColumn.id, src_column: srcColumn.name,
        src_data_type: srcColumn.data_type,
        tgt_column_id: tgtColumn.id, tgt_column: tgtColumn.name,
        tgt_data_type: tgtColumn.data_type,
        tgt_is_pk: tgtColumn.is_pk, score: 0, signals: {},
      });
    })().catch((e: Error) => {
      if (!cancelled) setError(e.message);
    });
    return () => {
      cancelled = true;
    };
  }, [params, handlePickPair]);

  const handlePickPending = (rel: PendingRelation) => {
    if (rel.src_object_id === null || rel.tgt_object_id === null
      || rel.src_column_id === null || rel.tgt_column_id === null) return;
    const nextSrc = objectFromQname(rel.src_object_id, rel.src_object);
    const nextTgt = objectFromQname(rel.tgt_object_id, rel.tgt_object);
    if (!nextSrc || !nextTgt) return;
    setSrc(nextSrc);
    setTgt(nextTgt);
    // 큐 항목은 타입을 싣지 않는다 — 게이트가 양측 타입을 다시 관측해 채운다
    handlePickPair({
      src_column_id: rel.src_column_id, src_column: rel.src_column, src_data_type: "",
      tgt_column_id: rel.tgt_column_id, tgt_column: rel.tgt_column, tgt_data_type: "",
      tgt_is_pk: false, score: rel.confidence ?? 0, signals: {},
    });
  };

  const handleRunGate = () => {
    if (!pair) return;
    const requested = pair;
    setGateBusy(true);
    setError(null);
    runGate(requested.src_column_id, requested.tgt_column_id)
      .then((gate) => {
        if (!isSamePair(requested, pairRef.current)) return;
        setState((cur) => applyGateResult(cur, gate));
      })
      .catch((e: Error) => {
        if (!isSamePair(requested, pairRef.current)) return;
        setError(e.message);
      })
      .finally(() => {
        if (isSamePair(requested, pairRef.current)) setGateBusy(false);
      });
  };

  const handleRunContainment = () => {
    if (!pair) return;
    const requested = pair;
    setContainmentBusy(true);
    setError(null);
    runContainment(requested.src_column_id, requested.tgt_column_id)
      .then((result) => {
        // 페어가 바뀌었으면 버린다 — 아니면 검증한 적 없는 페어가 "validated"로 올라선다
        if (!isSamePair(requested, pairRef.current)) return;
        setState((cur) => applyContainment(cur, result));
      })
      .catch((e: Error) => {
        if (!isSamePair(requested, pairRef.current)) return;
        setError(e.message);
      })
      .finally(() => {
        if (isSamePair(requested, pairRef.current)) setContainmentBusy(false);
      });
  };

  const handleConfirm = () => {
    if (!pair) return;
    const requested = pair;
    setConfirmBusy(true);
    setError(null);
    confirmRelation(requested.src_column_id, requested.tgt_column_id)
      .then(() => {
        // 확정 자체는 서버에 남는다 — 화면 상태만 현재 페어일 때 반영한다
        setPendingRefresh((cur) => cur + 1);
        if (!isSamePair(requested, pairRef.current)) return;
        setState(applyConfirm);
      })
      .catch((e: Error) => {
        if (!isSamePair(requested, pairRef.current)) return;
        setError(t("join.confirmFailed").replace("{error}", e.message));
      })
      .finally(() => {
        if (isSamePair(requested, pairRef.current)) setConfirmBusy(false);
      });
  };

  const previewOk = src !== null && tgt !== null
    && previewAllowed.has(src.schema) && previewAllowed.has(tgt.schema);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader>
        <span className="font-mono text-sm" style={{ color: "var(--muted)" }}
              data-testid="VerifyPage-pairLabel">
          {pair && src && tgt
            ? `${src.schema}.${src.name}.${pair.src_column} = ${tgt.schema}.${tgt.name}.${pair.tgt_column}`
            : t("verify.startHint")}
        </span>
      </AppHeader>

      <main className="grid min-h-0 flex-1 gap-3 p-3"
            style={{ gridTemplateColumns: "20rem minmax(0, 1fr) 20rem" }}
            data-testid="VerifyPage-root">
        <div className="scroll-area flex min-h-0 flex-col gap-3 overflow-y-auto">
          <TablePickerPanel side="src" selected={src}
                            onSelect={(obj) => handleSelectSide("src", obj)} />
          <TablePickerPanel side="tgt" selected={tgt}
                            onSelect={(obj) => handleSelectSide("tgt", obj)} />
          {src && tgt && (
            <PairCandidateList
              // 테이블이 바뀌면 후보·드롭다운 상태를 새로 시작한다
              key={`${src.id}-${tgt.id}`}
              srcObjectId={src.id}
              tgtObjectId={tgt.id}
              selectedPair={pair}
              onPick={handlePickPair}
            />
          )}
        </div>

        <div className="scroll-area flex min-h-0 flex-col gap-3 overflow-y-auto">
          {error && (
            <p className="text-sm" style={{ color: "var(--error)" }}
               data-testid="VerifyPage-errorText">
              {error}
            </p>
          )}
          {!pair && (
            <p className="text-sm" style={{ color: "var(--muted)" }}
               data-testid="VerifyPage-startHint">
              {t("verify.startHint")}
            </p>
          )}
          {pair && src && tgt && (
            <>
              <GateCard gate={state.gate} busy={gateBusy} onRun={handleRunGate} />
              <ContainmentCard
                result={state.containment}
                busy={containmentBusy}
                enabled={canRunContainment(state)}
                onRun={handleRunContainment}
              />
              <JoinPreviewCard
                srcColumnId={pair.src_column_id}
                tgtColumnId={pair.tgt_column_id}
                allowed={previewOk}
                srcObjectId={src.id}
                tgtObjectId={tgt.id}
              />
              <section className="card p-4" data-testid="VerifyPage-confirmCard">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold uppercase tracking-widest"
                        style={{ color: "var(--muted)" }}>
                    {t("verify.confirm.title")}
                  </span>
                  <button
                    className="btn-primary ml-auto !py-1.5 text-xs"
                    disabled={!canConfirm(state) || confirmBusy}
                    onClick={handleConfirm}
                    data-testid="VerifyPage-confirmButton"
                  >
                    {confirmBusy ? t("join.confirming") : t("verify.confirm.button")}
                  </button>
                </div>
                {state.step === "confirmed" && (
                  <p className="mt-2 text-sm" style={{ color: "var(--rel-confirmed)" }}
                     data-testid="VerifyPage-confirmDone">
                    ✓ {t("verify.confirm.done")}
                  </p>
                )}
              </section>
            </>
          )}
        </div>

        <PendingList onPick={handlePickPending} refreshToken={pendingRefresh} />
      </main>
    </div>
  );
}
