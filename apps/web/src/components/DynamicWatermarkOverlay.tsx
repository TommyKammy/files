'use client';

import { useEffect, useRef, useState } from 'react';

export function DynamicWatermarkOverlay({
  watermarkText,
  enabled,
  children,
}: {
  watermarkText: string | null | undefined;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [restoreVersion, setRestoreVersion] = useState(0);

  const activeText =
    enabled && watermarkText
      ? watermarkText
      : enabled
        ? 'CONFIDENTIAL • PROTECTED PREVIEW'
        : null;

  useEffect(() => {
    if (!activeText || !containerRef.current || !overlayRef.current) {
      return;
    }

    const container = containerRef.current;
    const overlay = overlayRef.current;
    let isMutating = false;

    const enforceOverlayIntegrity = () => {
      if (isMutating) return;
      isMutating = true;
      try {
        if (!container.contains(overlay)) {
          setRestoreVersion((v) => v + 1);
          return;
        }
        overlay.style.display = 'grid';
        overlay.style.opacity = '1';
        overlay.style.visibility = 'visible';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '40';
      } finally {
        queueMicrotask(() => {
          isMutating = false;
        });
      }
    };

    const observer = new MutationObserver(() => {
      enforceOverlayIntegrity();
    });

    observer.observe(container, { childList: true, subtree: true });
    observer.observe(overlay, {
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden'],
    });

    return () => observer.disconnect();
  }, [activeText, restoreVersion]);

  const tileItems = activeText
    ? Array.from({ length: 18 }, (_, i) => i)
    : [];

  return (
    <div
      ref={containerRef}
      onContextMenu={(e) => {
        if (enabled) e.preventDefault();
      }}
      className={`relative overflow-hidden select-none ${
        enabled ? 'watermark-protected-viewport' : ''
      }`}
    >
      {children}

      {activeText && (
        <div
          key={restoreVersion}
          ref={overlayRef}
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 40,
            pointerEvents: 'none',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gridTemplateRows: 'repeat(6, minmax(0, 1fr))',
            alignItems: 'center',
            justifyItems: 'center',
            overflow: 'hidden',
            userSelect: 'none',
          }}
        >
          {tileItems.map((idx) => (
            <span
              key={idx}
              style={{
                transform: 'rotate(-26deg)',
                fontSize: '12px',
                fontWeight: 600,
                letterSpacing: '0.04em',
                color: 'rgba(15, 23, 42, 0.16)',
                whiteSpace: 'nowrap',
              }}
            >
              {activeText}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
