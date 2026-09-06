import React, { useEffect } from 'react';
import { ErrorBoundary } from './ErrorBoundary.jsx';

export function Modal({ title, subtitle, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <h2>{title}</h2>
          {subtitle && <span className="label">{subtitle}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>Close</button>
        </div>
        <div className="modal__body"><ErrorBoundary>{children}</ErrorBoundary></div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}
