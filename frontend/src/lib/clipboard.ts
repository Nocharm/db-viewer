/** 클립보드 복사 — 사내 배포는 http(비보안 컨텍스트)라 clipboard API가 없을 수 있어
 * execCommand 폴백을 유지한다 / clipboard write with a non-secure-context fallback. */
export function copyText(text: string): void {
  const fallback = () => {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(fallback);
  } else {
    fallback();
  }
}
