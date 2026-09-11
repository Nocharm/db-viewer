/** 상대 시각 — 목록에서 "3분 전"이 절대 시각보다 먼저 읽힌다. 이틀 넘으면 날짜로.
 * Relative timestamps for list rows; older than yesterday falls back to MM-DD HH:mm. */

const pad = (n: number) => String(n).padStart(2, "0");

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return `${Math.floor(minutes / 60)}시간 전`;
  const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `어제 ${hhmm}`;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hhmm}`;
}
