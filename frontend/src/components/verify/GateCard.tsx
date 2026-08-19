"use client";

/** 사전 게이트 카드 — 값 조회 없이 타입 패밀리·표본 유니크니스로 조인 가능성을 거른다.
 * The pre-gate: blocks impossible joins from type family and sample uniqueness alone. */

import { useI18n } from "@/components/i18n";
import { GateIcon } from "@/components/icons";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import type { GateResult, GateSide } from "@/lib/api";

interface GateCardProps {
  gate: GateResult | null;
  busy: boolean;
  onRun: () => void;
}

/** 표본 유니크 비율 — 게이트가 임계값과 비교하는 그 값 / the ratio the gate thresholds on. */
function SideStat({ side, mismatch, threshold }: {
  side: GateSide;
  /** 타입 패밀리가 어긋난 쪽 — 붉게 표시한다 / flags the type badge red */
  mismatch: boolean;
  threshold: number;
}) {
  const ratio = side.ratio;
  return (
    <div className="flex-1">
      <div className="truncate font-mono text-xs" style={{ color: "var(--slate)" }}>
        {side.qname}.{side.column}
      </div>
      <div className="mt-1">
        <span className={mismatch ? "badge badge--unresolved" : "badge badge--muted"}>
          {side.data_type}
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums"
           style={{ color: ratio !== null && ratio < threshold ? "var(--error)" : "var(--ink)" }}>
        {ratio !== null ? `${(ratio * 100).toFixed(0)}%` : "—"}
      </div>
      <div className="mt-1 h-2 w-full rounded" style={{ background: "var(--surface-elevated)" }}>
        <div
          className="h-2 rounded"
          style={{
            width: `${Math.min(Math.max((ratio ?? 0) * 100, 0), 100)}%`,
            background: ratio !== null && ratio < threshold
              ? "var(--rel-unresolved)" : "var(--rel-confirmed)",
          }}
        />
      </div>
      <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        {side.sample_distinct ?? "—"} / {side.sample_rows ?? "—"}
      </div>
    </div>
  );
}

export function GateCard({ gate, busy, onRun }: GateCardProps) {
  const { t } = useI18n();
  const mismatch = gate !== null && gate.src.family !== gate.tgt.family;

  let verdictText = "";
  if (gate?.verdict === "pass") verdictText = t("verify.gate.pass");
  else if (gate?.reason === "type_mismatch") {
    verdictText = t("verify.gate.typeMismatch")
      .replace("{src}", gate.src.data_type)
      .replace("{tgt}", gate.tgt.data_type);
  } else if (gate?.reason === "both_low_distinct") {
    verdictText = t("verify.gate.bothLowDistinct");
  }

  return (
    <section className="card p-4" data-testid="GateCard-root">
      {/* 버튼은 제목 옆 — ml-auto로 카드 오른쪽 끝에 두면 넓은 화면에서 제목과
          ~900px 떨어져 시선·마우스가 왕복한다 / button hugs the title, not the far edge */}
      <StepCardHeader
        no={1}
        icon={<GateIcon size={15} />}
        title={t("verify.gate.title")}
        desc={t("verify.step1.desc")}
        done={gate?.verdict === "pass"}
      >
        <button
          className="btn-secondary !py-1 text-xs"
          disabled={busy}
          onClick={onRun}
          data-testid="GateCard-runButton"
        >
          {busy ? t("common.loading") : t("verify.gate.run")}
        </button>
      </StepCardHeader>

      {gate && (
        <>
          {/* 판정은 문장이라 .badge(uppercase)를 쓰지 않는다 — 배경색만 빌려온다
              a sentence, so it borrows .badge's tint without its uppercase transform */}
          <div className="mb-3">
            <span
              className="inline-block rounded-full px-3 py-1 text-xs font-semibold"
              style={gate.verdict === "pass"
                ? {
                    background: "color-mix(in srgb, var(--rel-confirmed) 18%, var(--surface-card))",
                    color: "var(--rel-confirmed)",
                  }
                : {
                    background: "color-mix(in srgb, var(--rel-unresolved) 18%, var(--surface-card))",
                    color: "var(--rel-unresolved)",
                  }}
              data-testid="GateCard-verdict"
            >
              {verdictText}
            </span>
          </div>
          <div className="mb-1 text-xs" style={{ color: "var(--muted)" }}>
            {t("verify.gate.ratioLabel")}
          </div>
          <div className="flex gap-4">
            <SideStat side={gate.src} mismatch={mismatch} threshold={gate.threshold} />
            <SideStat side={gate.tgt} mismatch={mismatch} threshold={gate.threshold} />
          </div>
        </>
      )}
    </section>
  );
}
