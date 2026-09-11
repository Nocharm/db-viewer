"use client";

/** 좌측 「진행 순서」 카드 — 1~4단계 설명 + 그 단계로 바로 이동.
 *
 * 흐름 설명과 이동 목록을 따로 그리면 같은 네 항목이 화면 두 곳에서 시선을 나눠 먹는다.
 * 그래서 설명(아이콘·한 줄·상태·잠김 사유)을 여기 한 카드에 모으고, 카드 자체가 해당
 * 섹션으로 가는 버튼이 된다. 선택 전에도 잠긴 상태로 보여 이 화면이 무엇을 하는지 먼저
 * 읽히게 한다. 렌더는 값 추적과 공유하는 StepNav가 맡고, 여기서는 네 단계의 문구만 고른다.
 * One card carries both the explanation and the navigation for the four steps.
 */

import { useI18n } from "@/components/i18n";
import { CheckIcon, ContainmentIcon, GateIcon, SampleIcon } from "@/components/icons";
import { StepNav, type StepNavItem } from "@/components/StepNav";
import type { VerifyStepState } from "@/lib/verify-steps";

interface VerifyStepNavProps {
  /** 1~4단계 상태 / the four step states, in order */
  states: VerifyStepState[];
  /** 중앙에 단계 카드가 떠 있는가 — 아니면 이동할 곳이 없어 버튼을 잠근다 */
  navigable: boolean;
  /** 단계 번호(1~4)로 이동 / jump to a step section */
  onNavigate: (no: number) => void;
}

export function VerifyStepNav({ states, navigable, onNavigate }: VerifyStepNavProps) {
  const { t } = useI18n();
  // 잠김 사유는 왜 아직 못 누르는지 — 3단계는 선택이라 사유가 없다 / step 3 is optional
  const items: StepNavItem[] = [
    { title: t("verify.gate.title"), desc: t("verify.step1.desc"),
      icon: <GateIcon size={15} />, lockNote: t("verify.lock.needPair") },
    { title: t("verify.containment.title"), desc: t("verify.step2.desc"),
      icon: <ContainmentIcon size={15} />, lockNote: t("verify.lock.needGate") },
    { title: t("verify.preview.title"), desc: t("verify.step3.desc"),
      icon: <SampleIcon size={15} />, optional: true },
    { title: t("verify.confirm.title"), desc: t("verify.step4.desc"),
      icon: <CheckIcon size={15} />, lockNote: t("verify.lock.needContainment") },
  ];

  return (
    <StepNav
      items={items}
      states={states}
      hint={navigable ? t("verify.nav.hint") : t("verify.flow.needTables")}
      navigable={navigable}
      onNavigate={onNavigate}
      testIdPrefix="VerifyStepNav"
    />
  );
}
