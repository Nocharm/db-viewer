"use client";

/** 업무 Postgres 연결 관리 — 등록·수정·삭제·연결 테스트·스키마 허용.
 *
 * 서비스마다 자기 Postgres를 갖고 있어 대상이 계속 늘어난다 — .env가 아니라 여기서
 * 목록을 관리한다. 편집은 미리보기 허용 목록과 같은 비밀번호를 요구한다(자격증명과
 * 값 노출 범위를 함께 다루는 화면이라 잠금을 하나로 맞춘다).
 * Registry editor for the business-Postgres connections.
 */

import { Fragment, useCallback, useEffect, useState } from "react";

import {
  createPgSource,
  fetchPgSourceSchemas,
  fetchPgSources,
  removePgSource,
  setPgSchemaUnlock,
  testPgSource,
  updatePgSource,
  type PgConnectionTest,
  type PgSchemaEntry,
  type PgSourceEntry,
  type PgSourceInput,
} from "@/lib/api";

const EMPTY_FORM: PgSourceInput = {
  slug: "", label: "", host: "", port: 5432, database: "", username: "", password: "",
  note: "",
};

export function PgSourcePanel() {
  const [password, setPassword] = useState("");
  const [items, setItems] = useState<PgSourceEntry[]>([]);
  const [secretConfigured, setSecretConfigured] = useState(true);
  const [passwordConfigured, setPasswordConfigured] = useState(true);
  const [form, setForm] = useState<PgSourceInput>(EMPTY_FORM);
  // 편집 중인 slug — null이면 「추가」 폼 / null means the form creates a new source
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<PgSchemaEntry[]>([]);
  const [tested, setTested] = useState<Record<string, PgConnectionTest>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() =>
    fetchPgSources()
      .then((res) => {
        setItems(res.items);
        setSecretConfigured(res.secret_configured);
        setPasswordConfigured(res.password_configured);
      })
      .catch((e: Error) => setError(e.message)), []);

  useEffect(() => { void reload(); }, [reload]);

  const canEdit = passwordConfigured && secretConfigured && password.length > 0;

  const run = (task: () => Promise<unknown>, done: string) => {
    setError(null);
    setMessage(null);
    task()
      .then(() => { setMessage(done); return reload(); })
      .catch((e: Error) => setError(e.message));
  };

  const loadSchemas = (slug: string) => {
    setSchemas([]);
    fetchPgSourceSchemas(slug)
      .then((res) => setSchemas(res.items))
      .catch((e: Error) => setError(e.message));
  };

  const toggleExpand = (slug: string) => {
    const next = expanded === slug ? null : slug;
    setExpanded(next);
    if (next) loadSchemas(next);
  };

  const startCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const startEdit = (item: PgSourceEntry) => {
    setEditing(item.slug);
    // 비밀번호는 되읽을 수 없다 — 비워 두면 기존 값 유지 / blank keeps the stored password
    setForm({ label: item.label, host: item.host, port: item.port, database: item.database,
              username: item.username, password: "", note: item.note ?? "" });
    setFormOpen(true);
  };

  const submit = () => {
    const payload: PgSourceInput = { ...form };
    if (!payload.password) delete payload.password;
    if (editing) {
      run(() => updatePgSource(editing, payload, password), `${editing} 연결 수정`);
    } else {
      run(() => createPgSource(payload, password), `${form.slug} 연결 등록`);
    }
    setFormOpen(false);
  };

  const field = (key: keyof PgSourceInput, label: string, type = "text") => (
    <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--slate)" }}>
      {label}
      <input
        className="rounded border px-2 py-1 text-sm"
        style={{ borderColor: "var(--border-light)" }}
        type={type}
        autoComplete="off"
        value={String(form[key] ?? "")}
        onChange={(e) => setForm((cur) => ({
          ...cur, [key]: key === "port" ? Number(e.target.value) || 0 : e.target.value,
        }))}
        data-testid={`AdminPage-pgSourceField-${key}`}
      />
    </label>
  );

  return (
    <section className="mb-6" data-testid="AdminPage-pgSourceSection">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium">업무 Postgres 연결</h2>
        <span className="badge badge--muted" data-testid="AdminPage-pgSourceCount">
          {items.length.toLocaleString()}
        </span>
        <button className="btn-primary ml-auto px-2.5 py-1 text-sm"
                disabled={!canEdit}
                title={canEdit ? undefined : "수정 비밀번호를 입력하세요"}
                onClick={startCreate}
                data-testid="AdminPage-pgSourceAddButton">
          연결 추가
        </button>
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
        각 서비스의 Postgres를 읽기 전용으로 조회합니다 (<code>/pg</code> 화면). 계정은 그 DB에 미리 만들어져
        있어야 하고, 비밀번호는 <code>PG_SOURCE_SECRET</code>으로 암호화해 저장되며 화면에 다시
        나오지 않습니다. 스키마를 허용해야 값이 보입니다 — 허용 전에는 테이블 이름만 보입니다.
      </p>

      {!secretConfigured && (
        <p className="mb-3 text-sm" style={{ color: "var(--error)" }}
           data-testid="AdminPage-pgSourceNoSecret">
          PG_SOURCE_SECRET이 설정되지 않아 연결을 등록·사용할 수 없습니다 — 서버 .env에 값을 넣고
          백엔드를 재기동하세요.
        </p>
      )}
      {!passwordConfigured && (
        <p className="mb-3 text-sm" style={{ color: "var(--error)" }}
           data-testid="AdminPage-pgSourceNoPassword">
          PREVIEW_ADMIN_PASSWORD가 설정되지 않아 목록을 수정할 수 없습니다.
        </p>
      )}
      {passwordConfigured && secretConfigured && (
        <input
          className="mb-3 w-64 rounded border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border-light)" }}
          type="password"
          autoComplete="off"
          placeholder="수정 비밀번호 (환경변수)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="AdminPage-pgSourcePasswordInput"
        />
      )}

      {formOpen && (
        <div className="mb-3 rounded border p-3"
             style={{ borderColor: "var(--border-light)" }}
             data-testid="AdminPage-pgSourceForm">
          <div className="grid grid-cols-3 gap-2">
            {!editing && field("slug", "식별자 (영소문자·숫자·-·_)")}
            {field("label", "표시 이름")}
            {field("host", "호스트")}
            {field("port", "포트", "number")}
            {field("database", "DB 이름")}
            {field("username", "사용자 (읽기 전용 계정)")}
            {field("password", editing ? "비밀번호 (비우면 유지)" : "비밀번호", "password")}
            {field("note", "메모 (선택)")}
          </div>
          <div className="mt-2 flex gap-2">
            <button className="btn-primary px-2.5 py-1 text-sm" disabled={!canEdit}
                    onClick={submit} data-testid="AdminPage-pgSourceSubmitButton">
              {editing ? "저장" : "등록"}
            </button>
            <button className="icon-button" onClick={() => setFormOpen(false)}
                    data-testid="AdminPage-pgSourceCancelButton">
              취소
            </button>
          </div>
        </div>
      )}

      <table className="w-full text-sm" data-testid="AdminPage-pgSourceTable">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
            <th className="py-1.5">이름</th><th>접속</th><th>허용 스키마</th><th className="w-56"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <Fragment key={item.slug}>
              <tr className="border-b"
                  style={{ borderColor: "var(--border-light)" }}
                  data-testid={`AdminPage-pgSourceRow-${item.slug}`}>
                <td className="py-1.5">
                  {item.label}
                  <span className="ml-1.5 font-mono text-xs" style={{ color: "var(--muted)" }}>
                    {item.slug}
                  </span>
                </td>
                <td className="font-mono text-xs" style={{ color: "var(--slate)" }}>
                  {item.username}@{item.host}:{item.port}/{item.database}
                </td>
                <td className="text-xs" style={{ color: "var(--slate)" }}
                    data-testid={`AdminPage-pgSourceAllowed-${item.slug}`}>
                  {item.allowed_schemas.length > 0 ? item.allowed_schemas.join(", ") : "없음"}
                </td>
                <td className="text-right">
                  <button className="icon-button row-action"
                          onClick={() => run(
                            () => testPgSource(item.slug).then((res) => {
                              setTested((cur) => ({ ...cur, [item.slug]: res }));
                              if (!res.ok) throw new Error(res.error ?? "연결 실패");
                            }),
                            `${item.label} 연결 성공`)}
                          data-testid={`AdminPage-pgSourceTestButton-${item.slug}`}>
                    연결 테스트
                  </button>
                  <button className="icon-button row-action"
                          onClick={() => toggleExpand(item.slug)}
                          data-testid={`AdminPage-pgSourceSchemasButton-${item.slug}`}>
                    스키마
                  </button>
                  <button className="icon-button row-action" disabled={!canEdit}
                          onClick={() => startEdit(item)}
                          data-testid={`AdminPage-pgSourceEditButton-${item.slug}`}>
                    수정
                  </button>
                  <button className="icon-button row-action" disabled={!canEdit}
                          onClick={() => run(() => removePgSource(item.slug, password),
                                             `${item.label} 연결 삭제`)}
                          data-testid={`AdminPage-pgSourceRemoveButton-${item.slug}`}>
                    삭제
                  </button>
                </td>
              </tr>
              {tested[item.slug] && (
                <tr data-testid={`AdminPage-pgSourceTestResult-${item.slug}`}>
                  <td colSpan={4} className="pb-1.5 text-xs"
                      style={{ color: tested[item.slug].ok ? "var(--rel-confirmed)" : "var(--error)" }}>
                    {tested[item.slug].ok
                      ? `연결 OK — 스키마 ${tested[item.slug].schemas?.length ?? 0}개 / 테이블 ${tested[item.slug].table_count ?? 0}개`
                      : `연결 실패 — ${tested[item.slug].error}`}
                  </td>
                </tr>
              )}
              {expanded === item.slug && (
                <tr data-testid={`AdminPage-pgSchemaPanel-${item.slug}`}>
                  <td colSpan={4} className="pb-3">
                    <div className="rounded border p-2"
                         style={{ borderColor: "var(--border-light)" }}>
                      {schemas.length === 0 && (
                        <p className="text-xs" style={{ color: "var(--muted)" }}>
                          스키마를 불러오는 중…
                        </p>
                      )}
                      {schemas.map((entry) => (
                        <div key={entry.schema}
                             className="flex items-center gap-2 py-1 text-xs"
                             data-testid={`AdminPage-pgSchemaRow-${item.slug}-${entry.schema}`}>
                          <span className="font-mono" style={{ color: "var(--ink)" }}>
                            {entry.schema}
                          </span>
                          <span style={{ color: "var(--muted)" }}>
                            테이블 {entry.table_count.toLocaleString()}개
                          </span>
                          <button
                            className={entry.allowed ? "icon-button ml-auto" : "btn-primary ml-auto px-2 py-0.5"}
                            disabled={!canEdit}
                            title={canEdit ? undefined : "수정 비밀번호를 입력하세요"}
                            onClick={() => run(
                              () => setPgSchemaUnlock(item.slug, entry.schema, !entry.allowed,
                                                      password)
                                .then(() => loadSchemas(item.slug)),
                              `${item.slug}:${entry.schema} ${entry.allowed ? "값 잠금" : "값 허용"}`)}
                            data-testid={`AdminPage-pgSchemaToggle-${item.slug}-${entry.schema}`}
                          >
                            {entry.allowed ? "값 잠그기" : "값 허용"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={4} className="py-2" style={{ color: "var(--muted)" }}
                    data-testid="AdminPage-pgSourceEmptyState">
              등록된 연결 없음
            </td></tr>
          )}
        </tbody>
      </table>

      {message && <p className="mt-2 text-sm" style={{ color: "var(--rel-confirmed)" }}
                     data-testid="AdminPage-pgSourceMessage">{message}</p>}
      {error && <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
                   data-testid="AdminPage-pgSourceError">{error}</p>}
    </section>
  );
}
