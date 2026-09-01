"use client";

/** 데이터 소스 등록부 — 등록·수정·활성화 전환·삭제·연결 테스트. 미리보기 허용 목록과 같은
 * 비밀번호 게이트(X-Preview-Password)를 쓴다. 소스가 없으면 나머지 관리 기능이 전부 무의미
 * 하므로 관리 콘솔의 첫 자리에 둔다.
 * Data source registry: create/edit/enable-toggle/delete/test, gated by the preview-admin
 * password — placed first in the admin console since nothing else works without a source. */

import { useCallback, useEffect, useState } from "react";

import {
  createDataSource,
  deleteDataSource,
  fetchDataSources,
  testDataSource,
  triggerCollectCatalog,
  updateDataSource,
  type DataSourceInput,
  type DataSourceItem,
} from "@/lib/api";
import { DownloadIcon } from "@/components/icons";

export interface SourceFormState {
  name: string;
  engine: "postgres" | "sqlite";
  host: string;
  port: number;
  database: string;
  username: string;
  // DB 접속 비밀번호 — 관리 게이트 비밀번호(X-Preview-Password)와는 다른 값이다
  password: string;
  file_path: string;
}

const EMPTY_FORM: SourceFormState = {
  name: "", engine: "postgres", host: "", port: 5432,
  database: "", username: "", password: "", file_path: "",
};

/** 엔진별 접속 필드만 추린다 — postgres는 host/port/database/username, sqlite는 file_path. */
function buildEngineFields(
  form: SourceFormState,
): Pick<DataSourceInput, "host" | "port" | "database" | "username" | "file_path"> {
  return form.engine === "sqlite"
    ? { file_path: form.file_path.trim() }
    : {
        host: form.host.trim(), port: form.port,
        database: form.database.trim(), username: form.username.trim(),
      };
}

/** 등록 요청 본문 — 비밀번호는 채웠을 때만 싣는다(트러스트 인증 등 무비번 접속도 허용). */
export function buildCreateInput(form: SourceFormState): DataSourceInput {
  const input: DataSourceInput = {
    name: form.name.trim(), engine: form.engine, ...buildEngineFields(form),
  };
  if (form.password) input.password = form.password;
  return input;
}

/** 수정 요청 본문 — engine 키가 없다(백엔드가 안 받는다: 엔진 변경은 소스 재생성으로 유도).
 * 비밀번호는 칸을 채웠을 때만 실어 "교체"로 해석시킨다 — 비워두면 기존 값이 유지된다. */
export function buildUpdateInput(form: SourceFormState): Partial<DataSourceInput> {
  const input: Partial<DataSourceInput> = { name: form.name.trim(), ...buildEngineFields(form) };
  if (form.password) input.password = form.password;
  return input;
}

/** 등록·수정 폼이 백엔드 400을 받기 전에 스스로 걸러낸다 — sources.py `_validate_shape`과
 * 같은 규칙(postgres는 host/port/database/username, sqlite는 file_path). */
export function isSourceFormValid(form: SourceFormState): boolean {
  if (!form.name.trim()) return false;
  return form.engine === "sqlite"
    ? form.file_path.trim().length > 0
    : Boolean(form.host.trim() && form.port && form.database.trim() && form.username.trim());
}

/** 목록 행에 보일 접속 위치 문자열 — 관리형(사내 MSSQL)은 host/file_path가 모두 비어 온다. */
function formatLocation(item: DataSourceItem): string {
  if (item.engine === "sqlite") return item.file_path ?? "—";
  if (item.host) return `${item.host}:${item.port ?? "?"}/${item.database ?? "?"}`;
  return "—";
}

function buildEditForm(item: DataSourceItem): SourceFormState {
  return {
    name: item.name, engine: item.engine === "sqlite" ? "sqlite" : "postgres",
    host: item.host ?? "", port: item.port ?? 5432, database: item.database ?? "",
    username: item.username ?? "", password: "", file_path: item.file_path ?? "",
  };
}

export function DataSourcePanel() {
  const [password, setPassword] = useState("");
  const [items, setItems] = useState<DataSourceItem[]>([]);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [createForm, setCreateForm] = useState<SourceFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<SourceFormState>(EMPTY_FORM);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      fetchDataSources()
        .then((res) => {
          setItems(res.items);
          setKeyConfigured(res.secret_key_configured);
        })
        .catch((e) => setError(e.message)),
    [],
  );

  useEffect(() => { void reload(); }, [reload]);

  // X-Preview-Password 게이트 — 미리보기 허용 목록과 같은 비밀번호. 암호화 저장이 걸린
  // 등록만 SOURCE_SECRET_KEY 존재 여부(keyConfigured)를 추가로 요구한다.
  const canMutate = password.length > 0;
  const canRegister = canMutate && isSourceFormValid(createForm);

  /** 작업 실행 → 메시지 표시 → 목록 갱신. task가 문자열을 반환하면 그 메시지를 쓴다
   * (관리 콘솔 AdminPage.run과 동일 관용 — 연결 테스트처럼 계산된 메시지가 필요해서). */
  const run = (task: () => Promise<unknown>, done: string) => {
    setError(null);
    setMessage(null);
    return task()
      .then((detail) => {
        setMessage(typeof detail === "string" ? detail : done);
        return reload();
      })
      .catch((e) => setError(e.message));
  };

  const handleCreate = () => {
    void run(
      () => createDataSource(buildCreateInput(createForm), password)
        .then(() => setCreateForm(EMPTY_FORM)),
      "소스를 등록했습니다",
    );
  };

  const startEdit = (item: DataSourceItem) => {
    setMessage(null);
    setError(null);
    setEditingId(item.id);
    setEditForm(buildEditForm(item));
  };

  const handleSaveEdit = (id: number) => {
    void run(
      () => updateDataSource(id, buildUpdateInput(editForm), password)
        .then(() => setEditingId(null)),
      "수정했습니다",
    );
  };

  const handleToggleEnabled = (item: DataSourceItem) => {
    void run(
      () => updateDataSource(item.id, { is_enabled: !item.is_enabled }, password),
      item.is_enabled ? "비활성화했습니다" : "활성화했습니다",
    );
  };

  const handleDelete = (item: DataSourceItem) => {
    void run(() => deleteDataSource(item.id, password), "삭제했습니다");
  };

  /** 새로 등록한 소스의 카탈로그를 수집한다 — sysadmin이면 되고 관리 비밀번호는 필요 없다
   * (collect API에는 그 게이트가 없다). direct 소스는 뷰 의존 단계가 없어 이 한 번으로 끝난다.
   * 진행률은 아래 CollectPanel이 잡 목록을 소스 구분 없이 보여주므로 여기서 중복 구현하지
   * 않는다 — 방금 만든 잡이 최신이라 CollectPanel에 자동으로 뜬다. */
  const handleCollect = (item: DataSourceItem) => {
    void run(
      () => triggerCollectCatalog(item.id).then((job) => `수집을 시작했습니다 — job #${job.job_id}`),
      "수집을 시작했습니다",
    );
  };

  /** 연결 테스트는 성공·실패 모두 서버가 last_ok_at/last_error를 커밋한다 — 공용 run()의
   * "실패 시 재조회 생략" 관용을 따르면 실패한 소스의 last_error가 목록에 안 뜬다. 그래서
   * 여기만 결과와 무관하게 항상 reload한다. */
  const handleTest = (item: DataSourceItem) => {
    setError(null);
    setMessage(null);
    testDataSource(item.id)
      .then((res) => {
        setMessage(`연결 성공 — ${res.database} (${res.version}), ${res.latency_ms}ms`);
      })
      .catch((e) => setError(e.message))
      .finally(() => void reload());
  };

  return (
    <section className="mb-6" data-testid="DataSourcePanel-root">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium">데이터 소스</h2>
        <span className="badge badge--muted" data-testid="DataSourcePanel-count">
          {items.length.toLocaleString()}
        </span>
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
        조회·수집·미리보기가 모두 여기 등록된 소스를 기준으로 동작합니다. 관리형(사내 MSSQL)
        소스는 배포 설정(.env / n8n)이 원본이라 이 화면에서 수정·삭제할 수 없습니다.
      </p>

      {/* 새 서비스 DB를 붙일 때 담당자에게 전달할 ELI5 안내서 — public 정적 파일을 내려받는다 */}
      <a
        className="btn-secondary mb-3 inline-flex items-center gap-1.5 text-sm"
        href="/handoff/integration-guide.html"
        download="db-viewer-연동안내서.html"
        data-testid="DataSourcePanel-guideDownload"
      >
        <DownloadIcon size={14} className="inline-block align-middle" />
        연동 안내서 내려받기
      </a>
      <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
        새 서비스 DB를 연결하려면 이 안내서(담당자용 연동 요청서)를 서비스 담당자에게 전달하세요.
      </p>

      {!keyConfigured && (
        <p className="mb-3 text-sm" style={{ color: "var(--error)" }}
           data-testid="DataSourcePanel-keyMissing">
          SOURCE_SECRET_KEY가 설정되지 않아 소스를 등록할 수 없습니다 — 서버 .env에 값을
          넣고 백엔드를 재기동하세요. (기존 소스의 활성화·비활성화·삭제는 계속 할 수 있습니다.)
        </p>
      )}

      <div className="mb-3 flex items-center gap-2">
        <input
          className="w-64 rounded border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border-light)" }}
          type="password"
          autoComplete="off"
          placeholder="관리 비밀번호 (수정용 — 접속 비밀번호와 다릅니다)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="DataSourcePanel-passwordInput"
        />
      </div>

      <ul className="mb-4 space-y-2" data-testid="DataSourcePanel-list">
        {items.map((item) => (
          <li key={item.id} className="card flex flex-col gap-2 p-3 text-sm"
              data-testid={`DataSourcePanel-item-${item.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.name}</span>
              <span className="badge badge--muted">{item.engine}</span>
              <span className="badge badge--muted">{item.access_mode}</span>
              {item.is_managed && (
                <span className="badge badge--muted" data-testid={`DataSourcePanel-managedBadge-${item.id}`}>
                  관리형 · 읽기전용
                </span>
              )}
              <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>
                {formatLocation(item)}
              </span>
              <span className="text-xs" style={{ color: "var(--slate)" }}>
                {item.has_password ? "비밀번호 설정됨" : "비밀번호 없음"}
              </span>
              <span className="text-xs"
                    style={{ color: item.is_enabled ? "var(--rel-confirmed)" : "var(--muted)" }}
                    data-testid={`DataSourcePanel-status-${item.id}`}>
                {item.is_enabled ? "활성" : "비활성"}
              </span>
              <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                {item.last_ok_at
                  ? `마지막 성공 ${new Date(item.last_ok_at).toLocaleString()}`
                  : "성공 이력 없음"}
              </span>
            </div>

            {item.last_error && (
              <p className="text-xs" style={{ color: "var(--error)" }}
                 data-testid={`DataSourcePanel-error-${item.id}`}>
                연결 실패 — {item.last_error}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {/* n8n 경유 소스(관리형 사내 MSSQL)는 access_mode!="direct"라 백엔드가 테스트를
                  항상 400으로 거부한다 — 눌러도 절대 성공 못 하는 버튼을 아예 안 보여준다. */}
              {!item.is_managed && (
                <button
                  className="icon-button"
                  onClick={() => handleTest(item)}
                  data-testid={`DataSourcePanel-testButton-${item.id}`}
                >
                  연결 테스트
                </button>
              )}
              {!item.is_managed && editingId !== item.id && (
                <>
                  <button
                    className="icon-button"
                    onClick={() => handleCollect(item)}
                    data-testid={`DataSourcePanel-collectButton-${item.id}`}
                  >
                    카탈로그 수집
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => startEdit(item)}
                    data-testid={`DataSourcePanel-editButton-${item.id}`}
                  >
                    수정
                  </button>
                  <button
                    className="icon-button"
                    disabled={!canMutate}
                    title={canMutate ? undefined : "관리 비밀번호를 입력하세요"}
                    onClick={() => handleToggleEnabled(item)}
                    data-testid={`DataSourcePanel-toggleButton-${item.id}`}
                  >
                    {item.is_enabled ? "비활성화" : "활성화"}
                  </button>
                  <button
                    className="icon-button"
                    disabled={!canMutate}
                    title={canMutate ? undefined : "관리 비밀번호를 입력하세요"}
                    onClick={() => handleDelete(item)}
                    data-testid={`DataSourcePanel-deleteButton-${item.id}`}
                  >
                    삭제
                  </button>
                </>
              )}
            </div>

            {editingId === item.id && (
              <div className="flex flex-wrap items-end gap-2 border-t pt-2"
                   style={{ borderColor: "var(--border-light)" }}
                   data-testid={`DataSourcePanel-editForm-${item.id}`}>
                <input
                  className="rounded border px-2 py-1 text-sm"
                  style={{ borderColor: "var(--border-light)" }}
                  placeholder="이름"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  data-testid={`DataSourcePanel-editNameInput-${item.id}`}
                />
                {editForm.engine === "sqlite" ? (
                  <input
                    className="rounded border px-2 py-1 text-sm"
                    style={{ borderColor: "var(--border-light)" }}
                    placeholder="파일 경로"
                    value={editForm.file_path}
                    onChange={(e) => setEditForm({ ...editForm, file_path: e.target.value })}
                    data-testid={`DataSourcePanel-editFilePathInput-${item.id}`}
                  />
                ) : (
                  <>
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      style={{ borderColor: "var(--border-light)" }}
                      placeholder="호스트"
                      value={editForm.host}
                      onChange={(e) => setEditForm({ ...editForm, host: e.target.value })}
                      data-testid={`DataSourcePanel-editHostInput-${item.id}`}
                    />
                    <input
                      className="w-20 rounded border px-2 py-1 text-sm"
                      style={{ borderColor: "var(--border-light)" }}
                      type="number"
                      value={editForm.port}
                      onChange={(e) => setEditForm({ ...editForm, port: Number(e.target.value) })}
                      data-testid={`DataSourcePanel-editPortInput-${item.id}`}
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      style={{ borderColor: "var(--border-light)" }}
                      placeholder="database"
                      value={editForm.database}
                      onChange={(e) => setEditForm({ ...editForm, database: e.target.value })}
                      data-testid={`DataSourcePanel-editDatabaseInput-${item.id}`}
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      style={{ borderColor: "var(--border-light)" }}
                      placeholder="읽기전용 계정"
                      value={editForm.username}
                      onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                      data-testid={`DataSourcePanel-editUsernameInput-${item.id}`}
                    />
                  </>
                )}
                <input
                  className="rounded border px-2 py-1 text-sm"
                  style={{ borderColor: "var(--border-light)" }}
                  type="password"
                  autoComplete="off"
                  placeholder={item.has_password ? "접속 비밀번호 (비우면 유지)" : "접속 비밀번호"}
                  value={editForm.password}
                  onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                  data-testid={`DataSourcePanel-editPasswordInput-${item.id}`}
                />
                <button
                  className="btn-secondary"
                  disabled={!canMutate || !isSourceFormValid(editForm)}
                  onClick={() => handleSaveEdit(item.id)}
                  data-testid={`DataSourcePanel-saveEditButton-${item.id}`}
                >
                  저장
                </button>
                <button
                  className="icon-button"
                  onClick={() => {
                    // 폼도 같이 비운다 — 안 그러면 취소한 접속 비밀번호가 다음 편집까지
                    // 컴포넌트 상태에 남는다(렌더·전송·로깅은 안 되지만 불필요한 잔류).
                    setEditingId(null);
                    setEditForm(EMPTY_FORM);
                  }}
                  data-testid={`DataSourcePanel-cancelEditButton-${item.id}`}
                >
                  취소
                </button>
              </div>
            )}
          </li>
        ))}
        {items.length === 0 && (
          <li className="text-sm" style={{ color: "var(--muted)" }}
              data-testid="DataSourcePanel-emptyState">
            등록된 소스가 없습니다
          </li>
        )}
      </ul>

      {keyConfigured && (
        <div className="flex flex-col gap-2 rounded border p-3"
             style={{ borderColor: "var(--border-light)" }}
             data-testid="DataSourcePanel-form">
          <div className="flex flex-wrap gap-2">
            <input
              className="rounded border px-2 py-1 text-sm"
              style={{ borderColor: "var(--border-light)" }}
              placeholder="이름"
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              data-testid="DataSourcePanel-nameInput"
            />
            <select
              className="rounded border px-2 py-1 text-sm"
              style={{ borderColor: "var(--border-light)" }}
              value={createForm.engine}
              onChange={(e) =>
                setCreateForm({ ...createForm, engine: e.target.value as "postgres" | "sqlite" })}
              data-testid="DataSourcePanel-engineSelect"
            >
              <option value="postgres">PostgreSQL</option>
              <option value="sqlite">SQLite</option>
            </select>
          </div>

          {createForm.engine === "sqlite" ? (
            <input
              className="rounded border px-2 py-1 text-sm"
              style={{ borderColor: "var(--border-light)" }}
              placeholder="/mnt/sources/svcc/app.db"
              value={createForm.file_path}
              onChange={(e) => setCreateForm({ ...createForm, file_path: e.target.value })}
              data-testid="DataSourcePanel-filePathInput"
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <input
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: "var(--border-light)" }}
                placeholder="컨테이너 이름 또는 네트워크 별칭"
                value={createForm.host}
                onChange={(e) => setCreateForm({ ...createForm, host: e.target.value })}
                data-testid="DataSourcePanel-hostInput"
              />
              <input
                className="w-20 rounded border px-2 py-1 text-sm"
                style={{ borderColor: "var(--border-light)" }}
                type="number"
                value={createForm.port}
                onChange={(e) =>
                  setCreateForm({ ...createForm, port: Number(e.target.value) })}
                data-testid="DataSourcePanel-portInput"
              />
              <input
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: "var(--border-light)" }}
                placeholder="database"
                value={createForm.database}
                onChange={(e) => setCreateForm({ ...createForm, database: e.target.value })}
                data-testid="DataSourcePanel-databaseInput"
              />
              <input
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: "var(--border-light)" }}
                placeholder="읽기전용 계정"
                value={createForm.username}
                onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                data-testid="DataSourcePanel-usernameInput"
              />
              <input
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: "var(--border-light)" }}
                type="password"
                autoComplete="off"
                placeholder="접속 비밀번호 (선택)"
                value={createForm.password}
                onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                data-testid="DataSourcePanel-secretInput"
              />
            </div>
          )}

          <button
            className="btn-primary self-start"
            disabled={!canRegister}
            title={canMutate ? undefined : "관리 비밀번호를 입력하세요"}
            onClick={handleCreate}
            data-testid="DataSourcePanel-createButton"
          >
            등록
          </button>
        </div>
      )}

      {message && (
        <p className="mt-2 text-sm" style={{ color: "var(--rel-confirmed)" }}
           data-testid="DataSourcePanel-message">
          {message}
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
           data-testid="DataSourcePanel-errorMessage">
          {error}
        </p>
      )}
    </section>
  );
}
