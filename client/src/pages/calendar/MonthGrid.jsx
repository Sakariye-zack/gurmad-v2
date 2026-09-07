import React from 'react';
import { useNavigate } from 'react-router-dom';
import { eachDay, isToday, toISODate } from './dateUtils.js';
import { isOverdue, eventsForDay } from './WeekGrid.jsx';

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_VISIBLE = 3;

export default function MonthGrid({ from, to, batches, focusMonth }) {
  const navigate = useNavigate();
  const days = eachDay(from, to);
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '5px', marginBottom: '5px' }}>
        {DOW_LABELS.map((l) => (
          <div key={l} style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textAlign: 'center', padding: '1px 0' }}>{l}</div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '5px' }}>
            {week.map((day) => {
              const inMonth = day.getMonth() === focusMonth.getMonth();
              const dayEvents = eventsForDay(batches, day);
              const visible = dayEvents.slice(0, MAX_VISIBLE);
              const overflow = dayEvents.length - visible.length;
              const today = isToday(day);
              return (
                <div
                  key={toISODate(day)}
                  style={{
                    border: `1px solid ${today ? 'var(--brand)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)', minHeight: '74px', padding: '4px',
                    background: inMonth ? 'var(--surface)' : 'var(--bg)', opacity: inMonth ? 1 : 0.55,
                    display: 'flex', flexDirection: 'column', gap: '2px',
                  }}
                >
                  <span style={{ fontSize: '10px', fontWeight: 700, color: today ? 'var(--brand)' : 'var(--text-muted)' }}>{day.getDate()}</span>
                  {visible.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => navigate(`/collection-cycles/batches/${b.id}`)}
                      title={`${b.batch_code} — ${b.zone_name}`}
                      style={{
                        textAlign: 'left', border: 'none', borderLeft: `3px solid ${isOverdue(b) ? 'var(--danger)' : 'var(--brand)'}`,
                        borderRadius: '3px', background: 'var(--bg)', padding: '1px 4px', cursor: 'pointer',
                        fontSize: '9.5px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        fontFamily: 'inherit',
                      }}
                    >
                      {b.batch_code}
                    </button>
                  ))}
                  {overflow > 0 && (
                    <span style={{ fontSize: '9.5px', color: 'var(--text-muted)', fontWeight: 700 }}>+{overflow} more</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
