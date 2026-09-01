"use client";

/** 헤더 소스 선택기 — 브라우저와 ERD가 공유한다.
 *  Header source picker, shared by the browser and the ERD. */

import { useDataSources } from "@/lib/use-data-sources";

interface SourceSelectorProps {
  value: number | null;
  onChange: (sourceId: number | null) => void;
}

export function SourceSelector({ value, onChange }: SourceSelectorProps) {
  const sources = useDataSources();

  // 소스가 하나뿐이면 고를 것이 없다 — 화면을 어지럽히지 않는다
  if (sources.length <= 1) return null;

  return (
    <select
      data-testid="SourceSelector-select"
      className="rounded border px-2 py-1 text-sm"
      value={value ?? sources[0]?.id ?? ""}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {sources.map((source) => (
        <option key={source.id} value={source.id}>
          {source.name} ({source.engine})
        </option>
      ))}
    </select>
  );
}
