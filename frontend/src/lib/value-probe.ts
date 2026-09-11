/** 값 추적 화면의 순수 로직 — 페이지는 얇게, 판단은 여기서 (vitest 대상).
 *  Pure helpers for the value-probe page; the page component stays thin. */

import type {
  SchemaCategoryItem, SkippedRelatedView, ValueProbeHit, ValueProbeJob, ValueProbeMode,
} from "@/lib/api";
import type { Lang } from "@/lib/i18n";
import type { PreviewFilterCond, PreviewFilterOp } from "@/lib/preview-utils";
import { withSourceQuery } from "@/lib/source-param";

// 타입 소유자는 api.ts(응답 스키마) — 화면은 이 모듈 하나만 import하면 되게 다시 내보낸다
export type { SkippedRelatedView };

/** 백엔드 PROBE_VALUE_MAX_LEN과 동일 — 미리보기 필터 값 상한과 같다 */
export const VALUE_MAX_LEN = 100;
// 백엔드 MAX_PREVIEW_FILTERS와 동일 / mirrors the backend cap
const MAX_DEEP_LINK_FILTERS = 5;
const FILTER_OPS: ReadonlySet<string> = new Set([
  "contains", "eq", "not_contains", "neq", "is_null", "not_null",
]);

export interface ProbeForm {
  sourceId: number | null;
  schemas: string[];
  value: string;
  hint: string;
  mode: ValueProbeMode;
  /** 선택 스키마의 테이블을 읽는 다른 스키마의 뷰까지 검색할지 / pull in related views */
  includeRelatedViews: boolean;
}

export type ProbeFormError = "trace.err.noSchema" | "trace.err.noValue" | "trace.err.valueTooLong";

/** 서버가 최종 판정하지만 뻔한 실수는 왕복 없이 막는다 / cheap client-side checks only. */
export function validateProbeRequest(form: ProbeForm): ProbeFormError | null {
  if (form.schemas.length === 0) return "trace.err.noSchema";
  if (form.value.trim() === "") return "trace.err.noValue";
  if (form.value.trim().length > VALUE_MAX_LEN) return "trace.err.valueTooLong";
  return null;
}

/** 고를 수 있는 스키마 = 허용 목록 ∩ 숨김 아님. 숨김 목록은 소문자로 내려온다. */
export function selectableSchemas(
  items: SchemaCategoryItem[], allowed: Set<string>, hidden: Set<string>,
): SchemaCategoryItem[] {
  return items.filter((item) => allowed.has(item.schema) && !hidden.has(item.schema.toLowerCase()));
}

/** 히트 → 미리보기 딥링크. 입력값이 아니라 실제 저장 형태(matched_variant)를 eq로 건다. */
export function buildPreviewHref(hit: ValueProbeHit, sourceId: number | null): string {
  const filters: PreviewFilterCond[] = [{ column: hit.column, op: "eq", value: hit.matched_variant }];
  const encoded = encodeURIComponent(JSON.stringify(filters));
  return withSourceQuery(`/?table=${hit.object_id}&preview=1&filters=${encoded}`, sourceId);
}

export function shouldKeepPolling(status: ValueProbeJob["status"]): boolean {
  return status === "queued" || status === "running";
}

/** "나머지 허용 스키마로 계속" — 허용 목록에서 이미 검색한 것을 뺀다. */
export function remainingSchemas(allowed: string[], searched: string[]): string[] {
  const done = new Set(searched);
  return allowed.filter((schema) => !done.has(schema));
}

/** 건수 표시 — 상한이면 "1000+", 생략(heavy)이면 null(호출부가 "확인됨"으로 표시). */
export function formatMatchCount(hit: ValueProbeHit): string | null {
  if (hit.match_count === null) return null;
  return hit.count_capped ? `${hit.match_count}+` : String(hit.match_count);
}

const SKIP_REASON: Record<SkippedRelatedView["reason"], { ko: string; en: string }> = {
  hidden: { ko: "숨김 스키마", en: "hidden schema" },
  not_allowed: { ko: "허용 목록 밖", en: "not on the preview allowlist" },
};

/** ⓘ 말풍선 한 줄 — 뷰 이름과 정책 사유 / one tooltip line: view + policy reason. */
export function describeSkippedView(item: SkippedRelatedView, lang: Lang): string {
  return `${item.qname} — ${SKIP_REASON[item.reason][lang]}`;
}

export type FindButtonMode = "find" | "progress" | "stop";

/** 찾기 버튼의 세 얼굴 — 대기·진행·중단(호버) / the find button's three states. */
export function findButtonLabel(
  state: { running: boolean; hovering: boolean; done: number; total: number },
): FindButtonMode {
  if (!state.running) return "find";
  return state.hovering ? "stop" : "progress";
}

function isFilterCond(value: unknown): value is PreviewFilterCond {
  if (typeof value !== "object" || value === null) return false;
  const cond = value as Record<string, unknown>;
  return typeof cond.column === "string" && typeof cond.op === "string"
    && FILTER_OPS.has(cond.op) && (typeof cond.value === "string" || cond.value === null);
}

/** `?filters=` 딥링크 파라미터 검증 — 잘못된 값은 무시하고 필터 없이 연다(null). */
export function parseFiltersParam(raw: string | null): PreviewFilterCond[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_DEEP_LINK_FILTERS) return null;
  if (!parsed.every(isFilterCond)) return null;
  return parsed.map((cond) => ({ column: cond.column, op: cond.op as PreviewFilterOp, value: cond.value }));
}
