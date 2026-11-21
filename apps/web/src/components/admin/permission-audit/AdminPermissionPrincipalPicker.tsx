'use client';

import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, searchPrincipals } from '@/lib/files-api';
import type { PrincipalCandidate } from '@/types/files';

const FIELD_CLASS =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40';

function principalLabel(principal: PrincipalCandidate): string {
  return principal.email
    ? `${principal.name} (${principal.email})`
    : principal.name;
}

export function PrincipalPicker({
  label,
  description,
  inputId,
  allowGroups,
  single = false,
  selected,
  onChange,
}: {
  label: string;
  description: string;
  inputId: string;
  allowGroups: boolean;
  single?: boolean;
  selected: PrincipalCandidate[];
  onChange: (next: PrincipalCandidate[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PrincipalCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const selectedKeys = useMemo(
    () => new Set(selected.map((item) => `${item.type}:${item.id}`)),
    [selected]
  );
  const listId = `${inputId}-results`;
  const descriptionId = `${inputId}-description`;

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchPrincipals(trimmed)
        .then((response) => {
          if (requestIdRef.current !== requestId) return;
          setResults(
            response.principals.filter(
              (candidate) =>
                (allowGroups || candidate.type === 'user') &&
                !selectedKeys.has(`${candidate.type}:${candidate.id}`)
            )
          );
          setError(null);
        })
        .catch((err) => {
          if (requestIdRef.current !== requestId) return;
          setResults([]);
          setError(
            err instanceof ApiClientError
              ? err.message
              : 'ユーザー・グループの検索に失敗しました'
          );
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, allowGroups, selectedKeys]);

  function addPrincipal(principal: PrincipalCandidate) {
    onChange(single ? [principal] : [...selected, principal]);
    setQuery('');
    setResults([]);
  }

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={inputId}
        className="block text-xs font-medium text-slate-700"
      >
        {label}
      </label>
      <p id={descriptionId} className="text-[0.6875rem] text-slate-500">
        {description}
      </p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
        <input
          id={inputId}
          name={inputId}
          type="search"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={descriptionId}
          aria-controls={listId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            allowGroups ? '名前・メール・グループ名で検索' : '名前・メールで検索'
          }
          className={`${FIELD_CLASS} pl-8`}
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-2.5 h-3.5 w-3.5 animate-spin text-slate-400" />
        )}
      </div>
      {error && (
        <p role="alert" className="text-[0.6875rem] text-red-700">
          {error}
        </p>
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label}の検索候補`}
        className="max-h-36 overflow-y-auto rounded-lg border border-slate-200 bg-white"
      >
        {results.map((principal) => (
          <li key={`${principal.type}:${principal.id}`}>
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => addPrincipal(principal)}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-blue-50 focus-visible:bg-blue-50 focus-visible:outline-none"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium text-slate-800">
                  {principal.name}
                </span>
                {principal.email && (
                  <span className="ml-1 text-slate-500">{principal.email}</span>
                )}
              </span>
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] text-slate-600">
                {principal.type === 'group' ? 'グループ' : 'ユーザー'}
              </span>
            </button>
          </li>
        ))}
        {!loading && query.trim().length > 0 && results.length === 0 && (
          <li className="px-2.5 py-2 text-[0.6875rem] text-slate-500">
            候補がありません
          </li>
        )}
      </ul>
      {selected.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label={`${label}の選択済み`}
        >
          {selected.map((principal) => (
            <li
              key={`selected:${principal.type}:${principal.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[0.6875rem] text-blue-900"
            >
              <span className="max-w-56 truncate">
                {principalLabel(principal)}
              </span>
              <button
                type="button"
                aria-label={`${principal.name}を選択から外す`}
                onClick={() =>
                  onChange(
                    selected.filter(
                      (item) =>
                        !(
                          item.type === principal.type &&
                          item.id === principal.id
                        )
                    )
                  )
                }
                className="rounded-full p-0.5 hover:bg-blue-100"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
