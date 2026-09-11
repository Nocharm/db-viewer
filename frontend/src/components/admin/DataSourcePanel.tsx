"use client";

/** 데이터 소스 등록부 — 등록·수정·활성화 전환·삭제·연결 테스트. 미리보기 허용 목록과 같은
 * 비밀번호 게이트(X-Preview-Password)를 쓰며, 비밀번호는 관리 콘솔의 잠금 바가 쥔다. 소스가
 * 없으면 나머지 관리 기능이 전부 무의미하므로 관리 콘솔의 첫 탭에 둔다. 삭제는 함께 사라질
 * 행(스냅샷·정책·값 추적 잡)을 먼저 보여주고 체크를 받은 뒤 cascade로 한 번에 지운다.
 * Data source registry: create/edit/enable-toggle/delete/test, gated by the preview-admin
 * password held by the console's lock bar — first tab of the admin console since nothing
 * else works without a source. Delete lists the dependents, requires an explicit
 * acknowledgement, then cascades. */

import { useCallback, useEffect, useState } from "react";

import {
  createDataSource,
  deleteDataSource,
  fetchDataSources,
  fetchSourceDependents,
  testDataSource,
  triggerCollectCatalog,
  updateDataSource,
  type DataSourceInput,
  type DataSourceItem,
  type SourceDependents,
} from "@/lib/api";
import {
  BanIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  DatabaseIcon,
  DownloadIcon,
  FileIcon,
  KeyIcon,
  LockIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from "@/components/icons";
import { formatRelativeTime } from "@/lib/relative-time";

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

export interface DependentLine {
  key: keyof SourceDependents;
  label: string;
  count: number;
}

/** 삭제 확인 상자에 나열할 "함께 삭제되는 것" — 백엔드 개수를 사람 말로. 순서 고정(스냅샷이
 * 가장 크고 되돌리기 어려워 맨 앞). / the dependents list for the confirm box, fixed order */
export function buildDependentLines(dependents: SourceDependents): DependentLine[] {
  return [
    { key: "snapshots", label: "수집 스냅샷 (카탈로그·컬럼·뷰 조인 포함)",
      count: dependents.snapshots },
    { key: "preview_allowlist", label: "미리보기 허용 스키마", count: dependents.preview_allowlist },
    { key: "schema_categories", label: "스키마 카테고리", count: dependents.schema_categories },
    { key: "value_probe_jobs", label: "값 추적 잡 (대상·히트 포함)",
      count: dependents.value_probe_jobs },
  ];
}

/** 삭제 완료 메시지의 꼬리 — 무엇이 얼마나 같이 지워졌는지 한 줄로. 없으면 그 사실을 말한다. */
export function formatCascadeSummary(dependents: SourceDependents): string {
  const parts = buildDependentLines(dependents)
    .filter((line) => line.count > 0)
    .map((line) => `${line.label.split(" (")[0]} ${line.count.toLocaleString()}건`);
  return parts.length ? `${parts.join("·")} 함께 삭제` : "함께 삭제된 정보 없음";
}

/** 삭제 확인 진행 상태 — 개수 조회 중(null)·조회 실패(error)·조회 완료(dependents) */
interface DeleteConfirmState {
  id: number;
  dependents: SourceDependents | null;
  error: string | null;
}

interface DataSourcePanelProps {
  /** 관리 비밀번호(X-Preview-Password) — 관리 콘솔 잠금 바가 쥔 값 */
  password: string;
  /** PREVIEW_ADMIN_PASSWORD가 서버에 설정돼 있는가 — 없으면 수정 조작이 전부 잠긴다 */
  passwordConfigured: boolean;
  /** 목록을 읽을 때마다 소스 수를 알린다 — 탭 카운트 pill용 */
  onLoaded?: (count: number) => void;
}

/** 마지막 연결 테스트 결과 한 줄 — 실패·성공·이력 없음 / last connection-test summary */
function describeLastTest(item: DataSourceItem): { tone: "err" | "ok" | "none"; text: string } {
  if (item.last_error) {
    return { tone: "err", text: `연결 실패 · ${item.last_ok_at ? `마지막 성공 ${formatRelativeTime(item.last_ok_at)}` : "성공 이력 없음"}` };
  }
  if (item.last_ok_at) return { tone: "ok", text: `연결 성공 · ${formatRelativeTime(item.last_ok_at)}` };
  return { tone: "none", text: "테스트 이력 없음" };
}

export function DataSourcePanel({ password, passwordConfigured, onLoaded }: DataSourcePanelProps) {
  const [items, setItems] = useState<DataSourceItem[]>([]);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [createForm, setCreateForm] = useState<SourceFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<SourceFormState>(EMPTY_FORM);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  // 체크박스 — 함께 삭제되는 내용을 읽었다는 표시. 대상이 바뀌면 다시 받는다
  const [cascadeAcknowledged, setCascadeAcknowledged] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      fetchDataSources()
        .then((res) => {
          setItems(res.items);
          setKeyConfigured(res.secret_key_configured);
          onLoaded?.(res.items.length);
        })
        .catch((e) => setError(e.message)),
    [onLoaded],
  );

  useEffect(() => { void reload(); }, [reload]);

  // X-Preview-Password 게이트 — 미리보기 허용 목록과 같은 비밀번호. 암호화 저장이 걸린
  // 등록만 SOURCE_SECRET_KEY 존재 여부(keyConfigured)를 추가로 요구한다.
  const canMutate = passwordConfigured && password.length > 0;
  const canRegister = canMutate && isSourceFormValid(createForm);
  const lockedTitle = canMutate ? undefined : "잠금 바에 관리 비밀번호를 입력하세요";

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
    setDeleteConfirm(null);
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

  /** 삭제 1단계 — 확인 상자를 열고 함께 사라질 행의 개수를 읽어 온다. 개수는 비동기라
   * 응답이 도착했을 때 여전히 같은 소스를 확인 중인지 검사한다(다른 카드로 옮겼으면 버림). */
  const startDelete = (item: DataSourceItem) => {
    setMessage(null);
    setError(null);
    setEditingId(null);
    setCascadeAcknowledged(false);
    setDeleteConfirm({ id: item.id, dependents: null, error: null });
    fetchSourceDependents(item.id)
      .then((dependents) => setDeleteConfirm((current) =>
        current?.id === item.id ? { ...current, dependents } : current))
      .catch((e: unknown) => setDeleteConfirm((current) => {
        const text = e instanceof Error ? e.message : String(e);
        return current?.id === item.id ? { ...current, error: text } : current;
      }));
  };

  const cancelDelete = () => {
    setDeleteConfirm(null);
    setCascadeAcknowledged(false);
  };

  /** 삭제 2단계 — 체크를 받은 뒤 cascade로 소스와 종속 행을 한 번에 지운다. */
  const confirmDelete = (item: DataSourceItem) => {
    void run(
      () => deleteDataSource(item.id, password, { cascade: true }).then((res) => {
        cancelDelete();
        return `삭제했습니다 — ${formatCascadeSummary(res.removed_dependents)}`;
      }),
      "삭제했습니다",
    );
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

  const setCreate = (patch: Partial<SourceFormState>) => setCreateForm({ ...createForm, ...patch });
  const setEdit = (patch: Partial<SourceFormState>) => setEditForm({ ...editForm, ...patch });

  return (
    <section className="mb-6" data-testid="DataSourcePanel-root">
      <div className="sec-head">
        <span className="sec-head__tile"><DatabaseIcon size={14} /></span>
        <h2 className="sec-head__title">데이터 소스</h2>
        <span className="cnt-pill" data-testid="DataSourcePanel-count">
          {items.length.toLocaleString()}
        </span>
        <div className="sec-head__right">
          {/* 새 서비스 DB를 붙일 때 담당자에게 전달할 ELI5 안내서 — public 정적 파일을 내려받는다 */}
          <a
            className="btn-secondary inline-flex items-center gap-1.5 text-sm"
            href="/handoff/integration-guide.html"
            download="db-viewer-연동안내서.html"
            data-testid="DataSourcePanel-guideDownload"
          >
            <DownloadIcon size={14} />
            연동 안내서 내려받기
          </a>
        </div>
      </div>
      <p className="sec-desc">
        조회·수집·미리보기가 모두 여기 등록된 소스를 기준으로 동작합니다. 관리형(사내 MSSQL)
        소스는 배포 설정(.env / n8n)이 원본이라 이 화면에서 수정·삭제할 수 없습니다. 새 서비스 DB를
        연결하려면 안내서(담당자용 연동 요청서)를 서비스 담당자에게 전달하세요.
      </p>

      {!keyConfigured && (
        <div className="banner banner--warn" data-testid="DataSourcePanel-keyMissing">
          <WarningIcon size={15} />
          <span>
            <b>SOURCE_SECRET_KEY가 설정되지 않았습니다.</b> 접속 비밀번호를 잠글 금고 열쇠가
            없어 새 소스를 등록할 수 없습니다 — 서버 .env에 값을 넣고 백엔드를 재기동하세요.
            기존 소스의 활성화·비활성화·삭제는 계속 할 수 있습니다.
          </span>
        </div>
      )}

      <ul className="mb-3 flex flex-col gap-2.5" data-testid="DataSourcePanel-list">
        {items.map((item) => {
          const lastTest = describeLastTest(item);
          const isPending = editingId !== item.id && deleteConfirm?.id !== item.id;
          return (
            <li
              key={item.id}
              className={`card src-card reveal-host text-sm${item.is_enabled ? "" : " src-card--off"}`}
              data-testid={`DataSourcePanel-item-${item.id}`}
            >
              <div className={`src-card__engine src-card__engine--${item.engine}`}>
                {item.engine === "sqlite" ? <FileIcon size={18} /> : <DatabaseIcon size={18} />}
              </div>
              <div className="src-card__top">
                <span className="src-card__name">{item.name}</span>
                <span className="badge badge--muted">{item.engine}</span>
                <span className="badge badge--muted">{item.access_mode}</span>
                {item.is_managed && (
                  <span className="badge badge--muted badge--plain"
                        data-testid={`DataSourcePanel-managedBadge-${item.id}`}>
                    <LockIcon size={11} />관리형 · 읽기전용
                  </span>
                )}
                <span className={`badge badge--plain ${item.is_enabled ? "badge--ok" : "badge--muted"}`}
                      data-testid={`DataSourcePanel-status-${item.id}`}>
                  <span className="badge__dot" />{item.is_enabled ? "활성" : "비활성"}
                </span>
              </div>
              <div className="src-card__meta">
                <span className="font-mono" style={{ color: "var(--slate)" }}>{formatLocation(item)}</span>
                <span className="src-card__kv">
                  <KeyIcon size={12} />{item.has_password ? "비밀번호 설정됨" : "비밀번호 없음"}
                </span>
                <span
                  className="src-card__kv"
                  style={{ color: lastTest.tone === "err" ? "var(--error)"
                    : lastTest.tone === "ok" ? "var(--deep-green)" : undefined }}
                  data-testid={`DataSourcePanel-lastTest-${item.id}`}
                >
                  {lastTest.tone === "err" ? <WarningIcon size={12} />
                    : lastTest.tone === "ok" ? <CheckIcon size={12} /> : <ClockIcon size={12} />}
                  {lastTest.text}
                </span>
              </div>

              {item.last_error && (
                <p className="src-card__error" data-testid={`DataSourcePanel-error-${item.id}`}>
                  <WarningIcon size={13} />{item.last_error}
                </p>
              )}

              <div className="src-card__actions">
                {/* n8n 경유 소스(관리형 사내 MSSQL)는 access_mode!="direct"라 백엔드가 테스트를
                    항상 400으로 거부한다 — 누를 수 없는 이유를 버튼이 직접 말한다. */}
                {item.is_managed ? (
                  <>
                    <button className="icon-button" disabled title="관리형 소스는 n8n이 접속합니다">
                      <PlugIcon size={13} />연결 테스트
                    </button>
                    <span className="badge badge--muted badge--plain">수집은 아래 카탈로그 수집에서</span>
                  </>
                ) : (
                  <button
                    className="icon-button"
                    onClick={() => handleTest(item)}
                    data-testid={`DataSourcePanel-testButton-${item.id}`}
                  >
                    <PlugIcon size={13} />연결 테스트
                  </button>
                )}
                {!item.is_managed && isPending && (
                  <>
                    <button
                      className="icon-button"
                      onClick={() => handleCollect(item)}
                      data-testid={`DataSourcePanel-collectButton-${item.id}`}
                    >
                      <DatabaseIcon size={13} />카탈로그 수집
                    </button>
                    <span className="src-card__spacer" />
                    {/* 부수 조작은 카드 hover·포커스에서만 드러난다(.reveal-action) — 목록을
                        훑을 때는 이름·상태·연결 테스트·수집만 보인다 */}
                    <button
                      className="icon-button reveal-action"
                      onClick={() => startEdit(item)}
                      data-testid={`DataSourcePanel-editButton-${item.id}`}
                    >
                      <PencilIcon size={13} />수정
                    </button>
                    <button
                      className="icon-button reveal-action"
                      disabled={!canMutate}
                      title={lockedTitle}
                      onClick={() => handleToggleEnabled(item)}
                      data-testid={`DataSourcePanel-toggleButton-${item.id}`}
                    >
                      {item.is_enabled ? <BanIcon size={13} /> : <CheckCircleIcon size={13} />}
                      {item.is_enabled ? "비활성화" : "활성화"}
                    </button>
                    <button
                      className="icon-button reveal-action ctl-field--danger"
                      disabled={!canMutate}
                      title={lockedTitle}
                      onClick={() => startDelete(item)}
                      data-testid={`DataSourcePanel-deleteButton-${item.id}`}
                    >
                      <TrashIcon size={13} />삭제
                    </button>
                  </>
                )}
              </div>

              {deleteConfirm?.id === item.id && (
                <div className="danger-box src-card__form flex flex-col gap-2"
                     data-testid={`DataSourcePanel-deleteConfirm-${item.id}`}>
                  <p className="flex items-center gap-1.5 font-medium" style={{ color: "var(--error)" }}>
                    <TrashIcon size={14} />
                    ‘{item.name}’ 소스를 삭제합니다 — 되돌릴 수 없습니다.
                  </p>
                  <p className="text-xs" style={{ color: "var(--body-text)" }}>
                    아래 정보가 <strong>함께 삭제</strong>됩니다. 접속만 끊고 기록은 남기려면
                    삭제 대신 비활성화를 쓰세요.
                  </p>
                  {deleteConfirm.error && (
                    <p className="text-xs" style={{ color: "var(--error)" }}
                       data-testid={`DataSourcePanel-dependentsError-${item.id}`}>
                      함께 삭제되는 항목을 확인하지 못했습니다 — {deleteConfirm.error}
                    </p>
                  )}
                  {!deleteConfirm.dependents && !deleteConfirm.error && (
                    <p className="text-xs" style={{ color: "var(--muted)" }}
                       data-testid={`DataSourcePanel-dependentsLoading-${item.id}`}>
                      함께 삭제되는 항목을 확인하는 중…
                    </p>
                  )}
                  {deleteConfirm.dependents && (
                    <ul className="flex flex-wrap gap-1.5"
                        data-testid={`DataSourcePanel-dependents-${item.id}`}>
                      {buildDependentLines(deleteConfirm.dependents).map((line) => (
                        <li key={line.key} className="stat-pill"
                            style={line.count === 0 ? { opacity: 0.55 } : undefined}
                            data-testid={`DataSourcePanel-dependent-${line.key}-${item.id}`}>
                          {line.label} <b>{line.count.toLocaleString()}건</b>
                        </li>
                      ))}
                    </ul>
                  )}
                  <label className="flex items-center gap-2 text-xs" style={{ color: "var(--ink)" }}>
                    <input
                      type="checkbox"
                      className="ctl-check"
                      checked={cascadeAcknowledged}
                      // 개수를 못 읽었으면 무엇이 지워지는지 모른 채 체크하게 되므로 잠근다
                      disabled={!deleteConfirm.dependents}
                      onChange={(e) => setCascadeAcknowledged(e.target.checked)}
                      data-testid={`DataSourcePanel-cascadeCheck-${item.id}`}
                    />
                    위 정보가 함께 삭제되는 것을 확인했습니다
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-secondary btn-danger"
                      disabled={!cascadeAcknowledged || !canMutate}
                      title={lockedTitle}
                      onClick={() => confirmDelete(item)}
                      data-testid={`DataSourcePanel-confirmDeleteButton-${item.id}`}
                    >
                      <TrashIcon size={13} />
                      함께 삭제
                    </button>
                    <button
                      className="icon-button"
                      onClick={cancelDelete}
                      data-testid={`DataSourcePanel-cancelDeleteButton-${item.id}`}
                    >
                      취소
                    </button>
                  </div>
                </div>
              )}

              {editingId === item.id && (
                <div className="src-card__form flex flex-wrap items-end gap-2 border-t pt-2"
                     style={{ borderColor: "var(--border-light)" }}
                     data-testid={`DataSourcePanel-editForm-${item.id}`}>
                  <input
                    className="ctl-field"
                    placeholder="이름"
                    value={editForm.name}
                    onChange={(e) => setEdit({ name: e.target.value })}
                    data-testid={`DataSourcePanel-editNameInput-${item.id}`}
                  />
                  {editForm.engine === "sqlite" ? (
                    <input
                      className="ctl-field"
                      placeholder="파일 경로"
                      value={editForm.file_path}
                      onChange={(e) => setEdit({ file_path: e.target.value })}
                      data-testid={`DataSourcePanel-editFilePathInput-${item.id}`}
                    />
                  ) : (
                    <>
                      <input
                        className="ctl-field"
                        placeholder="호스트"
                        value={editForm.host}
                        onChange={(e) => setEdit({ host: e.target.value })}
                        data-testid={`DataSourcePanel-editHostInput-${item.id}`}
                      />
                      <input
                        className="ctl-field w-24"
                        type="number"
                        value={editForm.port}
                        onChange={(e) => setEdit({ port: Number(e.target.value) })}
                        data-testid={`DataSourcePanel-editPortInput-${item.id}`}
                      />
                      <input
                        className="ctl-field"
                        placeholder="database"
                        value={editForm.database}
                        onChange={(e) => setEdit({ database: e.target.value })}
                        data-testid={`DataSourcePanel-editDatabaseInput-${item.id}`}
                      />
                      <input
                        className="ctl-field"
                        placeholder="읽기전용 계정"
                        value={editForm.username}
                        onChange={(e) => setEdit({ username: e.target.value })}
                        data-testid={`DataSourcePanel-editUsernameInput-${item.id}`}
                      />
                    </>
                  )}
                  <input
                    className="ctl-field"
                    type="password"
                    autoComplete="off"
                    placeholder={item.has_password ? "접속 비밀번호 (비우면 유지)" : "접속 비밀번호"}
                    value={editForm.password}
                    onChange={(e) => setEdit({ password: e.target.value })}
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
          );
        })}
        {items.length === 0 && (
          <li className="empty-state" data-testid="DataSourcePanel-emptyState">
            <DatabaseIcon size={22} />
            <span>등록된 소스가 없습니다</span>
          </li>
        )}
      </ul>

      {keyConfigured && (
        <details className="collapse" data-testid="DataSourcePanel-newSource">
          <summary>
            <PlusIcon size={14} />새 소스 등록
            <span className="badge badge--muted badge--plain">PostgreSQL · SQLite</span>
          </summary>
          <div className="form-grid" data-testid="DataSourcePanel-form">
            <label className="span-2">
              이름
              <input
                className="ctl-field"
                placeholder="svca"
                value={createForm.name}
                onChange={(e) => setCreate({ name: e.target.value })}
                data-testid="DataSourcePanel-nameInput"
              />
            </label>
            <label className="span-2">
              엔진
              <span className="seg" role="group" aria-label="엔진" data-testid="DataSourcePanel-engineSelect">
                <button
                  type="button"
                  className={`seg__btn${createForm.engine === "postgres" ? " seg__btn--on" : ""}`}
                  aria-pressed={createForm.engine === "postgres"}
                  onClick={() => setCreate({ engine: "postgres" })}
                  data-testid="DataSourcePanel-engine-postgres"
                >
                  <DatabaseIcon size={13} />PostgreSQL
                </button>
                <button
                  type="button"
                  className={`seg__btn${createForm.engine === "sqlite" ? " seg__btn--on" : ""}`}
                  aria-pressed={createForm.engine === "sqlite"}
                  onClick={() => setCreate({ engine: "sqlite" })}
                  data-testid="DataSourcePanel-engine-sqlite"
                >
                  <FileIcon size={13} />SQLite
                </button>
              </span>
            </label>
            {createForm.engine === "sqlite" ? (
              <label className="span-6">
                파일 경로 (backend 컨테이너 안)
                <input
                  className="ctl-field"
                  placeholder="/mnt/sources/svcc/app.db"
                  value={createForm.file_path}
                  onChange={(e) => setCreate({ file_path: e.target.value })}
                  data-testid="DataSourcePanel-filePathInput"
                />
              </label>
            ) : (
              <>
                <label className="span-2">
                  호스트 (네트워크 별칭)
                  <input
                    className="ctl-field"
                    placeholder="svca-db"
                    value={createForm.host}
                    onChange={(e) => setCreate({ host: e.target.value })}
                    data-testid="DataSourcePanel-hostInput"
                  />
                </label>
                <label className="span-2">
                  포트
                  <input
                    className="ctl-field"
                    type="number"
                    value={createForm.port}
                    onChange={(e) => setCreate({ port: Number(e.target.value) })}
                    data-testid="DataSourcePanel-portInput"
                  />
                </label>
                <label className="span-2">
                  database
                  <input
                    className="ctl-field"
                    placeholder="billing"
                    value={createForm.database}
                    onChange={(e) => setCreate({ database: e.target.value })}
                    data-testid="DataSourcePanel-databaseInput"
                  />
                </label>
                <label className="span-2">
                  읽기전용 계정
                  <input
                    className="ctl-field"
                    placeholder="dbviewer_ro"
                    value={createForm.username}
                    onChange={(e) => setCreate({ username: e.target.value })}
                    data-testid="DataSourcePanel-usernameInput"
                  />
                </label>
                <label className="span-3">
                  접속 비밀번호 (선택)
                  <input
                    className="ctl-field"
                    type="password"
                    autoComplete="off"
                    placeholder="보안 채널로 받은 값"
                    value={createForm.password}
                    onChange={(e) => setCreate({ password: e.target.value })}
                    data-testid="DataSourcePanel-secretInput"
                  />
                </label>
              </>
            )}
            <div className="form-grid__foot">
              <button
                className="btn-primary inline-flex items-center gap-1.5"
                disabled={!canRegister}
                title={lockedTitle}
                onClick={handleCreate}
                data-testid="DataSourcePanel-createButton"
              >
                <PlusIcon size={13} />등록
              </button>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                등록 직후 [연결 테스트]로 database·version이 회신값과 같은지 확인하세요.
              </span>
            </div>
          </div>
        </details>
      )}

      {message && (
        <div className="banner banner--ok mt-3" data-testid="DataSourcePanel-message">
          <CheckIcon size={15} /><span>{message}</span>
        </div>
      )}
      {error && (
        <div className="banner banner--err mt-3" data-testid="DataSourcePanel-errorMessage">
          <WarningIcon size={15} /><span>{error}</span>
        </div>
      )}
    </section>
  );
}
