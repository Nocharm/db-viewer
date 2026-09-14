"use client";

/** 미리보기 허용 스키마 관리 — 목록 편집에 환경변수 비밀번호를 요구한다(관리 콘솔 잠금 바가 쥔다).
 * Preview allowlist editor (schema-level); edits are gated by the env password from the lock bar. */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  addPreviewAllow,
  fetchPreviewAllowlistAdmin,
  fetchSchemaCategories,
  removePreviewAllow,
  type PreviewAllowEntry,
  type SchemaCategoryItem,
} from "@/lib/api";
import { useI18n } from "@/components/i18n";
import { BanIcon, CheckIcon, PlusIcon, ShieldIcon, WarningIcon } from "@/components/icons";

interface PreviewAllowlistPanelProps {
  /** 허용 목록 PK가 (data_source_id, schema)라 소스별로 조회·수정한다 — null은 사내 MSSQL. */
  sourceId: number | null;
  /** 관리 비밀번호(X-Preview-Password) — 관리 콘솔 잠금 바가 쥔 값 */
  password: string;
  passwordConfigured: boolean;
  /** 허용 스키마 수를 알린다 — 탭 카운트 pill용 */
  onLoaded?: (allowed: number) => void;
}

export function PreviewAllowlistPanel({
  sourceId, password, passwordConfigured, onLoaded,
}: PreviewAllowlistPanelProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<PreviewAllowEntry[]>([]);
  const [schemas, setSchemas] = useState<SchemaCategoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() =>
    fetchPreviewAllowlistAdmin(sourceId)
      .then((res) => {
        setEntries(res.items);
        onLoaded?.(res.items.length);
      })
      .catch((e) => setError(e.message)), [sourceId, onLoaded]);

  useEffect(() => { void reload(); }, [reload]);

  // 스키마 목록은 카탈로그가 곧 원본 — 카테고리 화면과 같은 소스를 쓴다
  useEffect(() => {
    fetchSchemaCategories(sourceId)
      .then((res) => setSchemas(res.items))
      .catch((e) => setError(e.message));
  }, [sourceId]);

  const allowedBySchema = useMemo(
    () => new Map(entries.map((entry) => [entry.schema, entry])),
    [entries],
  );

  const visibleSchemas = useMemo(() => {
    const term = query.trim().toLowerCase();
    const rows = term
      ? schemas.filter((item) => item.schema.toLowerCase().includes(term))
      : schemas;
    // 허용된 스키마를 위로 — 지금 무엇이 열려 있는지가 이 화면의 첫 질문이다
    return [...rows].sort((a, b) => {
      const allowedDiff = Number(allowedBySchema.has(b.schema))
        - Number(allowedBySchema.has(a.schema));
      return allowedDiff !== 0 ? allowedDiff : a.schema.localeCompare(b.schema);
    });
  }, [schemas, query, allowedBySchema]);

  const canEdit = passwordConfigured && password.length > 0;
  const lockedTitle = canEdit ? undefined : t("admin.lockedTitle");

  const run = (task: () => Promise<unknown>, done: string) => {
    setError(null);
    setMessage(null);
    task()
      .then(() => {
        setMessage(done);
        return reload();
      })
      .catch((e) => setError(e.message));
  };

  return (
    <section className="mb-6" data-testid="AdminPage-previewAllowSection">
      <div className="sec-head">
        <span className="sec-head__tile"><ShieldIcon size={14} /></span>
        <h2 className="sec-head__title">{t("allow.title")}</h2>
        <span className="cnt-pill" data-testid="AdminPage-previewAllowCount">
          {t("allow.count")
            .replace("{allowed}", entries.length.toLocaleString())
            .replace("{total}", schemas.length.toLocaleString())}
        </span>
        <div className="sec-head__right">
          <input
            className="ctl-field w-52"
            placeholder={t("allow.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="AdminPage-previewAllowSearchInput"
          />
        </div>
      </div>
      <p className="sec-desc">{t("allow.desc")}</p>

      {passwordConfigured && (
        <div className="mb-3 flex gap-2">
          <input
            className="ctl-field flex-1"
            placeholder={t("allow.notePlaceholder")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="AdminPage-previewAllowNoteInput"
          />
        </div>
      )}

      <div className="card">
        <div className="scroll-area max-h-96 overflow-y-auto"
             data-testid="AdminPage-previewAllowScroll">
          <table className="data-table" data-testid="AdminPage-previewAllowTable">
            <colgroup>
              <col style={{ width: "26%" }} /><col style={{ width: "12%" }} />
              <col /><col style={{ width: "20%" }} /><col style={{ width: "150px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>{t("allow.colSchema")}</th><th>{t("allow.colObjects")}</th>
                <th>{t("allow.colNote")}</th><th>{t("allow.colAddedBy")}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visibleSchemas.map((item) => {
                const entry = allowedBySchema.get(item.schema);
                return (
                  <tr key={item.schema} className="reveal-host"
                      data-testid={`AdminPage-previewAllowRow-${item.schema}`}>
                    <td>
                      <span className="font-mono text-xs" style={{ color: "var(--ink)" }}>{item.schema}</span>
                    </td>
                    <td><span className="cnt-pill">{item.object_count.toLocaleString()}</span></td>
                    <td className="text-xs" style={{ color: "var(--slate)" }}>{entry?.note ?? ""}</td>
                    <td className="text-xs" style={{ color: "var(--muted)" }}>{entry?.added_by ?? ""}</td>
                    <td className="text-right">
                      {entry ? (
                        // 허용 상태 pill과 해제 버튼이 같은 칸을 겹쳐 쓴다 — 평소엔 상태를 읽고,
                        // 행에 올리면 그 자리가 조작으로 바뀐다 (행 높이는 그대로)
                        <span className="row-swap">
                          <span className="badge badge--ok badge--plain row-act row-swap__rest"
                                data-testid={`AdminPage-previewAllowBadge-${item.schema}`}>
                            <CheckIcon size={11} />{t("allow.allowed")}
                          </span>
                          <button
                            className="icon-button ctl-field--danger row-act reveal-action"
                            disabled={!canEdit}
                            title={lockedTitle}
                            onClick={() => run(
                              () => removePreviewAllow(item.schema, password, sourceId),
                              t("allow.removeDone").replace("{schema}", item.schema))}
                            data-testid={`AdminPage-previewAllowRemoveButton-${item.schema}`}
                          >
                            <BanIcon size={13} />{t("allow.remove")}
                          </button>
                        </span>
                      ) : (
                        <button
                          className="btn-primary row-act reveal-action"
                          disabled={!canEdit}
                          title={lockedTitle}
                          onClick={() => run(
                            () => addPreviewAllow(
                              item.schema, password, note.trim() || undefined, sourceId,
                            ),
                            t("allow.addDone").replace("{schema}", item.schema),
                          )}
                          data-testid={`AdminPage-previewAllowAddButton-${item.schema}`}
                        >
                          <PlusIcon size={12} />{t("allow.add")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visibleSchemas.length === 0 && (
                <tr><td colSpan={5} style={{ color: "var(--muted)" }}
                        data-testid="AdminPage-previewAllowEmptyState">
                  {query.trim() ? t("allow.emptySearch") : t("allow.empty")}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {message && (
        <div className="banner banner--ok mt-3" data-testid="AdminPage-previewAllowMessage">
          <CheckIcon size={15} /><span>{message}</span>
        </div>
      )}
      {error && (
        <div className="banner banner--err mt-3" data-testid="AdminPage-previewAllowError">
          <WarningIcon size={15} /><span>{error}</span>
        </div>
      )}
    </section>
  );
}
