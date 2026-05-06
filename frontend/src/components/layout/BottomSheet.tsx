import { ReactNode } from 'react';

export function BottomSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="bottom-sheet-backdrop" onClick={onClose} role="presentation">
      <section className="bottom-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="false" aria-label={title}>
        <header className="bottom-sheet-header">
          <strong>{title}</strong>
          <button type="button" className="side-drawer-close" onClick={onClose}>Fechar</button>
        </header>
        <div className="bottom-sheet-content">{children}</div>
      </section>
    </div>
  );
}
