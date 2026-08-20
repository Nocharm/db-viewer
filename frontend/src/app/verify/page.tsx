"use client";

/** 1:1 조인 검증 화면 — 테이블 두 개 → 컬럼 페어 → 게이트 → 포함률 → 확정.
 * The 1:1 join verification flow: two tables, a column pair, gate, containment, confirm. */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { useI18n } from "@/components/i18n";
import { CheckIcon } from "@/components/icons";
import { ContainmentCard } from "@/components/verify/ContainmentCard";
import { GateCard } from "@/components/verify/GateCard";
import { JoinPreviewCard } from "@/components/verify/JoinPreviewCard";
import { PairCandidateList } from "@/components/verify/PairCandidateList";
import { PendingList } from "@/components/verify/PendingList";
import { SelectionPanel } from "@/components/verify/SelectionPanel";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import { TablePickerPanel } from "@/components/verify/TablePickerPanel";
import { VerifyStepNav } from "@/components/verify/VerifyStepNav";
import { VerifyStepper } from "@/components/verify/VerifyStepper";
import {
  confirmRelation, fetchObjectDetail, runContainment, runGate, searchObjects,
  type PairCandidate, type PendingRelation,
} from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";
import { usePreviewAllowlist } from "@/lib/use-preview-allowlist";
import { isSamePair } from "@/lib/verify-pair";
import { getVerifyStepStates } from "@/lib/verify-steps";
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
  // src=&srcCol=만 있고 tgt가 없는 딥링크의 srcCol — 페어를 못 만들어도 버리지 않고
  // PairCandidateList의 수동 선택(src쪽)을 미리 채우는 데 쓴다
  const [manualSrcColumnId, setManualSrcColumnId] = useState<number | null>(null);
  const [state, setState] = useState<VerifyState>(createInitialState);
  const [gateBusy, setGateBusy] = useState(false);
  const [containmentBusy, setContainmentBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 확정하면 대기 큐에서 내려간다 — 값을 올려 PendingList에 재조회를 지시
  const [pendingRefresh, setPendingRefresh] = useState(0);
  // 대기 큐에서 골라 온 항목 — 목록에 "지금 작업 중인 항목" 표시용. 수동 조작으로
  // 페어가 바뀌면 큐 항목과 어긋나므로 함께 해제한다
  const [pickedPendingId, setPickedPendingId] = useState<number | null>(null);
  // 3단계(샘플)는 선택 단계라 상태머신에 없다 — 흐름 다이어그램의 완료 표시용으로만 든다
  const [sampleSeen, setSampleSeen] = useState(false);
  // 선택 영역 접힘 — 셋 다 고른 순간 자동으로 접고, 헤더로 다시 펼쳐 수정한다
  const [pickCollapsed, setPickCollapsed] = useState(false);

  // 선택이 완성되면 좌측을 접어 검증 카드에 자리를 내주고, 하나라도 풀리면 다시 펼친다
  // — 사용자가 수동으로 펼친 상태는 선택이 그대로인 한 유지된다
  const picksComplete = src !== null && tgt !== null && pair !== null;
  useEffect(() => {
    setPickCollapsed(picksComplete);
  }, [picksComplete]);

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
    setSampleSeen(false);
    setError(null);
    setPickedPendingId(null); // 수동 페어 선택은 큐 항목과의 연결을 끊는다
    clearBusy();
  }, [clearBusy]);

  const handleSelectSide = (side: "src" | "tgt", obj: ObjectSummary | null) => {
    if (side === "src") {
      setSrc(obj);
      setManualSrcColumnId(null); // 소스가 바뀌면 이전 딥링크의 srcCol은 더 이상 유효하지 않다
    } else setTgt(obj);
    setPair(null);
    setState(resetForNewPair());
    setSampleSeen(false);
    setError(null);
    setPickedPendingId(null);
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
      if (!srcCol || !tgtCol || !nextSrc || !nextTgt) {
        // tgt가 없으면(또는 tgtCol이 없으면) 페어를 완성할 수 없다 — srcCol은 버리지 않고
        // 수동 선택 초기값으로 넘겨, 사용자가 tgt를 고른 뒤 이어서 채워지게 한다
        if (srcCol && nextSrc) setManualSrcColumnId(Number(srcCol));
        return;
      }
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
    // handlePickPair의 해제보다 나중에 설정 — 같은 배치에서 마지막 값이 남는다
    setPickedPendingId(rel.id);
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

  /** 좌측 검증 카드 → 해당 섹션으로 스크롤 + 테두리 한 번 깜빡 / jump and flash. */
  const navigateToStep = (no: number) => {
    const el = document.getElementById(`verify-step-${no}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // 같은 카드를 연속으로 누를 때도 다시 돌게 — 클래스를 뗐다 붙이며 리플로를 강제한다
    el.classList.remove("flash-attention");
    void el.offsetWidth;
    el.classList.add("flash-attention");
    window.setTimeout(() => el.classList.remove("flash-attention"), 2600);
  };

  const stepStates = getVerifyStepStates(state, pair !== null, sampleSeen);

  const previewOk = src !== null && tgt !== null
    && previewAllowed.has(src.schema) && previewAllowed.has(tgt.schema);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 시작 안내는 본문 중앙(startHint)에만 — 헤더에 한 번 더 띄우면 행동 지점(좌측 패널)의
          정반대 코너에서 같은 문구가 중복된다. 헤더는 선택된 페어 요약만 담는다.
          / the start hint lives in the content area only; the header carries the pair summary */}
      <AppHeader>
        {pair && src && tgt && (
          <span className="font-mono text-sm" style={{ color: "var(--muted)" }}
                data-testid="VerifyPage-pairLabel">
            {`${src.schema}.${src.name}.${pair.src_column} = ${tgt.schema}.${tgt.name}.${pair.tgt_column}`}
          </span>
        )}
      </AppHeader>

      <main className="grid min-h-0 flex-1 gap-3 p-3"
            style={{ gridTemplateColumns: "20rem minmax(0, 1fr) 20rem" }}
            data-testid="VerifyPage-root">
        <div className="scroll-area flex min-h-0 flex-col gap-3 overflow-y-auto">
          <SelectionPanel
            collapsed={pickCollapsed}
            onToggle={() => setPickCollapsed((cur) => !cur)}
            src={src} tgt={tgt} pair={pair}
          >
            <TablePickerPanel side="src" selected={src} peerSchema={tgt?.schema ?? null}
                              onSelect={(obj) => handleSelectSide("src", obj)} />
            <TablePickerPanel side="tgt" selected={tgt} peerSchema={src?.schema ?? null}
                              onSelect={(obj) => handleSelectSide("tgt", obj)} />
            {src && tgt && (
              <PairCandidateList
                // 테이블이 바뀌면 후보·드롭다운 상태를 새로 시작한다
                key={`${src.id}-${tgt.id}`}
                srcObjectId={src.id}
                tgtObjectId={tgt.id}
                selectedPair={pair}
                onPick={handlePickPair}
                initialManualSrcColumnId={manualSrcColumnId}
              />
            )}
          </SelectionPanel>

          {/* 검증 카드는 선택이 끝난 뒤에만 — 그 전에는 누를 대상 섹션이 없다 */}
          {picksComplete && (
            <VerifyStepNav states={stepStates} onNavigate={navigateToStep} />
          )}
        </div>

        <div className="scroll-area flex min-h-0 flex-col gap-3 overflow-y-auto">
          {error && (
            <p className="text-sm" style={{ color: "var(--error)" }}
               data-testid="VerifyPage-errorText">
              {error}
            </p>
          )}
          {/* 흐름 다이어그램은 페어 전에도 보여준다 — 처음 오는 사람이 무엇을 하는
              화면인지, 다음에 무엇을 눌러야 하는지 먼저 읽게 한다
              / the flow shows before a pair exists: it explains the screen itself */}
          <VerifyStepper src={src} tgt={tgt} pair={pair} state={state}
                         sampleSeen={sampleSeen} />
          {!pair && (
            <p className="text-sm" style={{ color: "var(--muted)" }}
               data-testid="VerifyPage-startHint">
              {t("verify.startHint")}
            </p>
          )}
          {pair && src && tgt && (
            <>
              {/* id는 좌측 검증 카드의 이동 목적지 — 깜빡임(box-shadow)도 이 래퍼가 받는다 */}
              <div id="verify-step-1" className="rounded-xl">
                <GateCard gate={state.gate} busy={gateBusy} onRun={handleRunGate} />
              </div>
              <div id="verify-step-2" className="rounded-xl">
                <ContainmentCard
                  result={state.containment}
                  busy={containmentBusy}
                  enabled={canRunContainment(state)}
                  onRun={handleRunContainment}
                />
              </div>
              <div id="verify-step-3" className="rounded-xl">
                <JoinPreviewCard
                  srcColumnId={pair.src_column_id}
                  tgtColumnId={pair.tgt_column_id}
                  allowed={previewOk}
                  srcObjectId={src.id}
                  tgtObjectId={tgt.id}
                  onViewed={() => setSampleSeen(true)}
                />
              </div>
              <section id="verify-step-4" className="card p-4" data-testid="VerifyPage-confirmCard">
                <StepCardHeader
                  no={4}
                  icon={<CheckIcon size={15} />}
                  title={t("verify.confirm.title")}
                  desc={t("verify.step4.desc")}
                  lockNote={canConfirm(state) || state.step === "confirmed"
                    ? null : t("verify.lock.needContainment")}
                  done={state.step === "confirmed"}
                >
                  <button
                    className="btn-primary !py-1.5 text-xs"
                    disabled={!canConfirm(state) || confirmBusy}
                    onClick={handleConfirm}
                    data-testid="VerifyPage-confirmButton"
                  >
                    {confirmBusy ? t("join.confirming") : t("verify.confirm.button")}
                  </button>
                </StepCardHeader>
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

        {/* filterQnames — 피커에 고른 테이블(출발·대상)이 걸린 항목만 남는 반응형 필터 */}
        <PendingList onPick={handlePickPending} refreshToken={pendingRefresh}
                     selectedId={pickedPendingId}
                     filterQnames={[src, tgt].filter((o) => o !== null)
                       .map((o) => `${o.schema}.${o.name}`)} />
      </main>
    </div>
  );
}
