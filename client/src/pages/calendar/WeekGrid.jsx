import React from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '../../components/ui/index.js';
import { eachDay, formatDayLabel, isToday, toISODate } from './dateUtils.js';
import { eventTarget, eventTooltip, isSoftEvent, primaryLabel, progressLabel, rangeLabel } from './calendarEvent.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

function chipStyle(color) {
  return { fontSize: '9px', fontWeight: 700, padding: '0 5px', borderRadius: '999px', color, border: `1px solid ${color}`, lineHeight: '14px', flexShrink: 0 };
}

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
  const { t } = useI18n();
  const navigate = useNavigate();
  const days = eachDay(from, to);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '8px' }}>
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
              {dayEvents.map((b) => {
                const soft = isSoftEvent(b);
                const edge = isOverdue(b) ? 'var(--danger)' : 'var(--brand)';
                return (
                  <button
                    key={b.id}
                    onClick={() => navigate(eventTarget(b, toISODate(day)))}
                    style={{
                      textAlign: 'left', border: soft ? '1px dashed var(--border)' : 'none',
                      borderLeft: `3px ${soft ? 'dashed' : 'solid'} ${edge}`,
                      borderRadius: '3px', background: soft ? 'transparent' : 'var(--bg)', padding: '4px 6px', cursor: 'pointer',
                      display: 'flex', flexDirection: 'column', gap: '2px', fontFamily: 'inherit', color: 'var(--text)',
                      opacity: soft ? 0.75 : 1, minWidth: 0,
                    }}
                    title={eventTooltip(b)}
                  >
                    {/* Explicit color required: a <button>'s UA default text color
                        (black) does not inherit var(--text) from <body> the way a
                        <div>/<span> would — found as a dark-theme readability defect. */}
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{primaryLabel(b)}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                      {b.auto_generated && <span style={chipStyle('var(--info)')}>{t('opsp.sourceAuto')}</span>}
                      <span className="tabular-nums" style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{progressLabel(b)}</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.zone_name}</span>
                    </span>
                    {soft && <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rangeLabel(b)}</span>}
                    <StatusBadge status={b.status} />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { isOverdue, eventsForDay, chipStyle };
