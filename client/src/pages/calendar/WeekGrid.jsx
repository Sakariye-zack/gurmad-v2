import React from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '../../components/ui/index.js';
import { eachDay, formatDayLabel, isToday, toISODate } from './dateUtils.js';

// Overdue is explicitly a derived, client-side-only visual indicator
// (Decisions §"Status") — never persisted, computed here from end_date vs.
// today plus status, matching the exact Spec definition.
function isOverdue(batch) {
  if (!batch.end_date) return false;
  if (batch.status === 'completed' || batch.status === 'cancelled') return false;
  return batch.end_date < toISODate(new Date());
}

function eventsForDay(batches, day) {
  const iso = toISODate(day);
  return batches.filter((b) => b.start_date <= iso && (!b.end_date || b.end_date >= iso));
}

export default function WeekGrid({ from, to, batches }) {
  const navigate = useNavigate();
  const days = eachDay(from, to);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px' }}>
      {days.map((day) => {
        const dayEvents = eventsForDay(batches, day);
        const today = isToday(day);
        return (
          <div
            key={toISODate(day)}
            style={{
              border: `1px solid ${today ? 'var(--brand)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-sm)', minHeight: '120px', display: 'flex', flexDirection: 'column',
              background: 'var(--surface)', overflow: 'hidden',
            }}
          >
            <div style={{
              padding: '5px 8px', fontSize: '11px', fontWeight: 700,
              color: today ? 'var(--brand)' : 'var(--text-muted)', borderBottom: '1px solid var(--border)',
              background: today ? 'var(--success-bg)' : 'transparent',
            }}>
              {formatDayLabel(day)}
            </div>
            <div style={{ padding: '4px', display: 'flex', flexDirection: 'column', gap: '4px', overflowY: 'auto', flex: 1 }}>
              {dayEvents.length === 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '3px 3px', opacity: 0.5 }}>—</div>
              )}
              {dayEvents.map((b) => (
                <button
                  key={b.id}
                  onClick={() => navigate(`/collection-cycles/batches/${b.id}`)}
                  style={{
                    textAlign: 'left', border: 'none', borderLeft: `3px solid ${isOverdue(b) ? 'var(--danger)' : 'var(--brand)'}`,
                    borderRadius: '3px', background: 'var(--bg)', padding: '4px 6px', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', gap: '2px', fontFamily: 'inherit',
                  }}
                  title={`${b.batch_code} — ${b.zone_name}`}
                >
                  <span style={{ fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.batch_code}</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.zone_name}</span>
                  <StatusBadge status={b.status} />
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { isOverdue, eventsForDay };
