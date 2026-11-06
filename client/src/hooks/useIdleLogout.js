import { useCallback, useEffect, useRef, useState } from 'react';

// Account security — idle auto-logout for the staff app. After 30 minutes
// without mouse/keyboard/touch activity the user is signed out (which
// revokes the server session); a warning shows for the last 60 seconds.
// Activity is shared across this browser's tabs via localStorage, so a
// user working in one tab isn't signed out by another idle tab.
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const IDLE_WARNING_MS = 60 * 1000;
const STORAGE_KEY = 'gurmad_v2_last_activity';
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];

function readShared() {
  try { return Number(localStorage.getItem(STORAGE_KEY)) || 0; } catch { return 0; }
}
function writeShared(ts) {
  try { localStorage.setItem(STORAGE_KEY, String(ts)); } catch { /* storage blocked */ }
}

export function useIdleLogout({ enabled, onTimeout }) {
  const lastRef = useRef(0);
  const lastWriteRef = useRef(0);
  const warningRef = useRef(false);
  const firedRef = useRef(false);
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(IDLE_WARNING_MS / 1000));
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => { onTimeoutRef.current = onTimeout; }, [onTimeout]);

  const markActive = useCallback(() => {
    const now = Date.now();
    lastRef.current = now;
    if (now - lastWriteRef.current > 10000) { lastWriteRef.current = now; writeShared(now); }
  }, []);

  const stayActive = useCallback(() => {
    lastWriteRef.current = 0;
    markActive();
    warningRef.current = false;
    setWarning(false);
  }, [markActive]);

  useEffect(() => {
    if (!enabled) return undefined;
    firedRef.current = false;
    warningRef.current = false;
    lastRef.current = Date.now();
    lastWriteRef.current = lastRef.current;
    writeShared(lastRef.current);
    // While the warning is up, only the explicit "Stay signed in" button
    // keeps the session — a stray mouse move shouldn't silently cancel it.
    const onActivity = () => { if (!warningRef.current) markActive(); };
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const last = Math.max(lastRef.current, readShared());
      const idle = Date.now() - last;
      if (idle >= IDLE_TIMEOUT_MS) {
        if (!firedRef.current) { firedRef.current = true; onTimeoutRef.current && onTimeoutRef.current(); }
        return;
      }
      const inWarning = idle >= IDLE_TIMEOUT_MS - IDLE_WARNING_MS;
      warningRef.current = inWarning;
      setWarning(inWarning);
      if (inWarning) setSecondsLeft(Math.max(0, Math.ceil((IDLE_TIMEOUT_MS - idle) / 1000)));
    }, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
      window.clearInterval(timer);
    };
  }, [enabled, markActive]);

  return { warning, secondsLeft, stayActive };
}
