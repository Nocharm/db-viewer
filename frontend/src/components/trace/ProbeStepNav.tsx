"use client";

/** 값 추적 좌측 「진행 순서」 — 조건 → 진행 → 찾은 컬럼 → 무거운 객체(선택).
 *  조인 검증 화면과 같은 카드로 지금 어디인지 보여주고, 누르면 그 카드로 내려간다.
 *  The value-probe side navigator; state comes from the job alone. */

import { useI18n } from "@/components/i18n";
import { DatabaseIcon, ListIcon, SampleIcon, SearchIcon } from "@/components/icons";
import { StepNav, type StepNavItem } from "@/components/StepNav";
import type { ValueProbeJob } from "@/lib/api";
import { getProbeStepStates } from "@/lib/value-probe";

interface ProbeStepNavProps {
  job: ValueProbeJob | null;
  /** 단계 번호(1~4)로 이동 / jump to a step card */
  onNavigate: (no: number) => void;
}

export function ProbeStepNav({ job, onNavigate }: ProbeStepNavProps) {
  const { t } = useI18n();
  // 제목은 각 카드의 StepCardHeader와 같은 키 — 왼쪽 목록과 오른쪽 카드가 같은 이름으로 읽힌다
  const items: StepNavItem[] = [
    { title: t("trace.form.title"), desc: t("trace.step1.desc"), icon: <SearchIcon size={15} /> },
    { title: t("trace.progress.title"), desc: t("trace.step2.desc"),
      icon: <SampleIcon size={15} />, lockNote: t("trace.lock.needJob") },
    { title: t("trace.hits.title"), desc: t("trace.step3.desc"),
      icon: <ListIcon size={15} />, lockNote: t("trace.lock.needJob") },
    { title: t("trace.heavy.title"), desc: t("trace.step4.desc"),
      icon: <DatabaseIcon size={15} />, optional: true, lockNote: t("trace.lock.noHeavy") },
  ];

  return (
    <StepNav
      items={items}
      states={getProbeStepStates(job)}
      hint={job ? t("verify.nav.hint") : t("trace.flow.intro")}
      // 조건 카드는 항상 있으므로 이동은 늘 가능하다 — 없는 카드로의 이동은 페이지가 무시한다
      navigable
      onNavigate={onNavigate}
      testIdPrefix="ProbeStepNav"
    />
  );
}
