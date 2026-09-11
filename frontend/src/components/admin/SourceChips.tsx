"use client";

/** 소스 칩 선택기 — 공개 범위 탭에서 "어느 소스의 허용 목록인가"를 고른다. 소스가 하나뿐이면
 * 고를 게 없으니 스스로 숨는다. 관리형 사내 MSSQL은 기본 소스라 값 null로 표현한다.
 * Source chips for the disclosure tab; hides itself with a single source. */

import { useEffect, useState } from "react";

import { fetchDataSources, type DataSourceItem } from "@/lib/api";
import { DatabaseIcon, FileIcon } from "@/components/icons";

interface SourceChipsProps {
  /** null = 사내 MSSQL(기본 소스) */
  value: number | null;
  onChange: (id: number | null) => void;
}

export function SourceChips({ value, onChange }: SourceChipsProps) {
  const [items, setItems] = useState<DataSourceItem[]>([]);

  useEffect(() => {
    fetchDataSources()
      .then((res) => setItems(res.items))
      .catch(() => setItems([]));  // 소스 목록 실패는 허용 목록 패널이 이미 보고한다
  }, []);

  if (items.length < 2) return null;

  return (
    <div className="chip-row" data-testid="SourceChips-root">
      대상 소스
      {items.map((item) => {
        const id = item.is_managed ? null : item.id;
        const on = id === value;
        return (
          <button
            key={item.id}
            type="button"
            className={`src-chip${on ? " src-chip--on" : ""}`}
            aria-pressed={on}
            onClick={() => onChange(id)}
            data-testid={`SourceChips-chip-${item.id}`}
          >
            {item.engine === "sqlite" ? <FileIcon size={12} /> : <DatabaseIcon size={12} />}
            {item.name}
          </button>
        );
      })}
    </div>
  );
}
