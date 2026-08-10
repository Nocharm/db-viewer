/** 플랫 라인 아이콘 세트 — currentColor 스트로크로 테마 자동 대응 (이모지 대체).
 * Flat line icons: no fills, currentColor strokes, so light/dark themes just work.
 *
 * 규격은 SearchPanel의 기존 돋보기를 따른다 — 24 뷰박스·stroke 2.4·round cap.
 * 이모지는 OS 폰트에 따라 모양·크기·색이 제각각이라 UI 톤이 깨진다. */

interface IconProps {
  /** 렌더 크기(px) — 기본 14는 icon-button 안에서 텍스트와 같은 광학 크기 */
  size?: number;
  className?: string;
}

function Svg({ size = 14, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 L20.5 20.5" />
    </Svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Svg {...props}>
      {/* 말풍선 — 꼬리를 좌하단으로 빼 대화 방향을 암시 */}
      <path d="M20 15a2.5 2.5 0 0 1-2.5 2.5H9L5 21v-4H4.5A2.5 2.5 0 0 1 2 14.5v-8A2.5 2.5 0 0 1 4.5 4h13A2.5 2.5 0 0 1 20 6.5z" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6 L18 18" />
      <path d="M18 6 L6 18" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </Svg>
  );
}

export function CaretDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9.5 L12 15.5 L18 9.5" />
    </Svg>
  );
}

export function CaretRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 6 L15.5 12 L9.5 18" />
    </Svg>
  );
}

export function ResetIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </Svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M6 13l6 6 6-6" />
    </Svg>
  );
}

/** 브랜드 마크 — 옐로 라운드 스퀘어 + DB 실린더. app/icon.svg(파비콘)와 같은 도형이다.
 * 둘이 어긋나면 탭과 화면의 브랜드가 달라 보이므로 지오메트리를 맞춰 유지한다.
 * Brand mark mirroring app/icon.svg so the tab and the UI show the same logo. */
export function LogoMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={className} aria-hidden
    >
      <rect width="32" height="32" rx={size >= 24 ? 7 : 5} fill="var(--primary)" />
      <g fill="none" stroke="var(--on-primary)" strokeWidth="2.4">
        <ellipse cx="16" cy="10.5" rx="8.5" ry="3.8" />
        <path d="M7.5 10.5v11c0 2.1 3.8 3.8 8.5 3.8s8.5-1.7 8.5-3.8v-11" />
        <path d="M7.5 16c0 2.1 3.8 3.8 8.5 3.8s8.5-1.7 8.5-3.8" />
      </g>
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      {/* 자물쇠 — 미리보기 미허용 스키마 표시 / preview-locked schema marker */}
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </Svg>
  );
}

export function LockOpenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      {/* 풀린 자물쇠 — 미리보기 허용 스키마 표시. 고리가 오른쪽 위로 열려 있다
          / open lock for preview-allowed schemas, shackle lifted to the right */}
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 7.7-1.5" />
    </Svg>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      {/* 연필 — 카테고리 칩의 편집 어포던스 / edit affordance on the category chip */}
      <path d="M4 20l1.2-4.2L16.7 4.3a2.1 2.1 0 0 1 3 3L8.2 18.8 4 20z" />
    </Svg>
  );
}
