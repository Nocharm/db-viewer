"use client";

/** 1:1 조인 검증 화면 — 테이블 두 개 → 컬럼 페어 → 게이트 → 포함률 → 확정.
 * The 1:1 join verification flow: two tables, a column pair, gate, containment, confirm. */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { PreviewSection } from "@/components/browser/PreviewSection";
import { useI18n } from "@/components/i18n";
import { CheckIcon } from "@/components/icons";
import { ContainmentCard } from "@/components/verify/ContainmentCard";
import { GateCard } from "@/components/verify/GateCard";
import { JoinPreviewCard } from "@/components/verify/JoinPreviewCard";
import { PairCandidateList } from "@/components/verify/PairCandidateList";
import { JoinDiagramCard } from "@/components/verify/JoinDiagramCard";
import { PendingList } from "@/components/verify/PendingList";
import { SelectionPanel } from "@/components/verify/SelectionPanel";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import { TablePickerPanel } from "@/components/verify/TablePickerPanel";
import { VerifyStepNav } from "@/components/verify/VerifyStepNav";
import {
  confirmRelation, fetchObjectDetail, runContainment, runGate, searchObjects,
  type ObjectDetail, type PairCandidate, type PendingRelation,
} from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";
import { usePreviewAllowlist } from "@/lib/use-preview-allowlist";
import { usePreviewTabs } from "@/lib/use-preview-tabs";
import {
  applyManualSelection, buildManualPair, isSamePair, toManualSelection,
} from "@/lib/verify-pair";
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

type DetailColumn = ObjectDetail["columns"][number];

/** 선택된 테이블의 컬럼 목록 — 상단 다이어그램의 컬럼 교체와 후보 패널이 함께 쓴다.
 * 후보 패널은 선택이 끝나면 접히며 사라지므로, 목록은 페이지가 들고 있어야 한다.
 * The column list lives here because the candidate panel unmounts when folded. */
function useObjectColumns(
  objectId: number | null, onError: (message: string) => void,
): DetailColumn[] {
  const [columns, setColumns] = useState<DetailColumn[]>([]);
  useEffect(() => {
    if (objectId === null) {
      setColumns([]);
      return;
    }
    let cancelled = false;
    fetchObjectDetail(objectId)
      .then((detail) => {
        if (!cancelled) setColumns(detail.columns);
      })
      .catch((e: Error) => {
        if (!cancelled) onError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [objectId, onError]);
  return columns;
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
  const preview = usePreviewTabs();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
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
  const srcColumns = useObjectColumns(src?.id ?? null, setError);
  const tgtColumns = useObjectColumns(tgt?.id ?? null, setError);

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

  /** 상단 상자에서 컬럼을 바꾼다 — 페어를 다시 세우고, 열려 있는 미리보기의 강조도 옮긴다.
   * 행은 다시 조회하지 않는다(같은 테이블이고 컬럼만 바뀐다). */
  const handleChangeColumn = (side: "src" | "tgt", columnId: number | null) => {
    const next = applyManualSelection(toManualSelection(pair), side, columnId);
    const built = buildManualPair(next, srcColumns, tgtColumns);
    if (!built) {
      // 한 쪽을 비웠다 — 페어가 풀리면 지금까지의 검증 결과는 이 페어의 것이 아니다
      setPair(null);
      setState(resetForNewPair());
      setSampleSeen(false);
      setError(null);
      setPickedPendingId(null);
      clearBusy();
      return;
    }
    handlePickPair(built);
    if (src) preview.setHighlight(src.id, built.src_column);
    if (tgt) preview.setHighlight(tgt.id, built.tgt_column);
  };

  /** 양쪽 테이블을 분할로 띄우고 지금 컬럼을 강조한다 — 조인 판단은 결국 값을 봐야 선다.
   * Opens both tables side by side with the pair's columns highlighted. */
  const handleOpenPreview = () => {
    if (!src || !tgt || !pair) return;
    preview.open(src.id, `${src.schema}.${src.name}`, pair.src_column);
    if (tgt.id !== src.id) {
      preview.open(tgt.id, `${tgt.schema}.${tgt.name}`, pair.tgt_column);
      preview.setSplitId(tgt.id); // 분할이 기본 — 두 컬럼을 나란히 놓고 비교한다
    }
    preview.setActiveId(src.id); // 왼쪽 창은 출발 테이블
    // 섹션이 붙은 다음 프레임에 내려간다 — 그 전에는 스크롤 목표가 없다
    setTimeout(() => previewRef.current?.scrollIntoView(
      { behavior: "smooth", block: "start" }), 60);
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

      {/* 미리보기는 화면을 덮지 않고 검증 영역 **아래로 이어 붙는다** — 테이블 화면·ERD와
          같은 문법이다. 안쪽 h-full 덕에 미리보기가 없으면 스크롤도 생기지 않는다
          / the preview is a section below, not an overlay (same as the table screen) */}
      <div ref={scrollRef} className="scroll-area min-h-0 flex-1">
        <div className="flex h-full flex-col">
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
                  srcColumns={srcColumns}
                  tgtColumns={tgtColumns}
                  selectedPair={pair}
                  onPick={handlePickPair}
                  initialManualSrcColumnId={manualSrcColumnId}
                />
              )}
            </SelectionPanel>

            {/* 진행 순서 = 설명 + 이동. 선택 전에도 잠긴 채 보여 이 화면이 무엇을 하는지
                먼저 읽히게 한다 (중앙에 같은 목록을 또 그리지 않는다) */}
            <VerifyStepNav states={stepStates} navigable={picksComplete}
                           onNavigate={navigateToStep} />
          </div>

          <div className="scroll-area flex min-h-0 flex-col gap-3 overflow-y-auto">
            {error && (
              <p className="text-sm" style={{ color: "var(--error)" }}
                 data-testid="VerifyPage-errorText">
                {error}
              </p>
            )}
            {/* 무엇을 검증 중인지만 — 단계 목록은 좌측 「진행 순서」가 맡는다
                / what is under test; the step list lives in the left flow card */}
            <JoinDiagramCard
              src={src} tgt={tgt} pair={pair} state={state}
              srcColumns={srcColumns} tgtColumns={tgtColumns}
              onChangeColumn={handleChangeColumn}
              previewAllowed={previewOk}
              onPreview={handleOpenPreview}
            />
            {pair && src && tgt && (
              <>
                {/* id = 좌측 진행 순서의 이동 목적지. 깜빡임은 카드 자신에게 건다 —
                    래퍼에 걸면 바깥 링의 좌우가 스크롤 컨테이너에 잘린다 */}
                <GateCard id="verify-step-1" gate={state.gate} busy={gateBusy}
                          onRun={handleRunGate} />
                <ContainmentCard
                  id="verify-step-2"
                  result={state.containment}
                  busy={containmentBusy}
                  enabled={canRunContainment(state)}
                  onRun={handleRunContainment}
                />
                <JoinPreviewCard
                  id="verify-step-3"
                  srcColumnId={pair.src_column_id}
                  tgtColumnId={pair.tgt_column_id}
                  allowed={previewOk}
                  srcObjectId={src.id}
                  tgtObjectId={tgt.id}
                  onViewed={() => setSampleSeen(true)}
                />
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

        {preview.tabs.length > 0 && (
          <div ref={previewRef} className="px-3 pb-3" data-testid="VerifyPage-previewSection">
            {preview.error && (
              <p className="mb-2 text-sm" style={{ color: "var(--error)" }}
                 data-testid="VerifyPage-previewError">
                {preview.error}
              </p>
            )}
            <PreviewSection
              tabs={preview.tabs}
              activeId={preview.activeId}
              splitId={preview.splitId}
              onActivate={preview.setActiveId}
              onClose={preview.close}
              onSplitPick={preview.setSplitId}
              onRefetch={preview.refetch}
              onPatch={preview.patch}
              // 「위로」는 검증 카드로 되돌린다 / back up to the verification cards
              onJumpToTop={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
