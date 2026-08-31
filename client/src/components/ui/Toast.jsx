import React, { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

// Design_System.md §11: toast is for immediate feedback on a just-completed
// action only — never for something the user needs to act on later (that's
// the persistent notification list's job, built in the module phase).
const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const api = {
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'error'),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div style={{ position: 'fixed', top: '16px', right: '16px', zIndex: 200, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {toasts.map((t) => (
          <div key={t.id} style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: t.type === 'error' ? 'var(--danger-bg)' : 'var(--success-bg)',
            color: t.type === 'error' ? 'var(--danger)' : 'var(--success)',
            fontWeight: 700, fontSize: '13px', boxShadow: 'var(--shadow-md)', minWidth: '220px',
          }}>
            {t.type === 'error' ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
            {t.message}
            <button
              onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
              aria-label="Dismiss"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.7 }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
