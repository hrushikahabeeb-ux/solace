'use client';
import type { E2EEEngine } from '../lib/e2ee';

import { useMemo, useState } from 'react';
import type { WireEventWithParticipants } from '../lib/api';
import { DecryptedText } from './DecryptedText';

type ViewMode = 'agenda' | 'month';
type Rsvp = 'GOING' | 'MAYBE' | 'DECLINED';

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function daysInMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function CalendarView({
  events,
  loading,
  e2ee,
  myUserId,
  onOpenEvent,
  onRsvp,
  onCreateNew,
}: {
  events: WireEventWithParticipants[];
  loading: boolean;
  e2ee: E2EEEngine | null;
  myUserId: string;
  onOpenEvent: (eventId: string) => void;
  onRsvp: (eventId: string, status: Rsvp) => void;
  onCreateNew: () => void;
}) {
  const [view, setView] = useState<ViewMode>('agenda');
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const upcoming = useMemo(
    () => [...events].filter((e) => new Date(e.startAt) >= new Date(new Date().setHours(0, 0, 0, 0))).sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt)),
    [events],
  );
  const dayFiltered = selectedDay ? events.filter((e) => sameDay(new Date(e.startAt), selectedDay)) : upcoming;

  return (
    <div className="flex-1 overflow-y-auto bg-canvas p-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl text-ink-canvas">Schedule</h2>
          <div className="flex items-center gap-2">
            <div className="flex rounded-pill bg-canvas-alt p-0.5 text-xs">
              <button onClick={() => setView('agenda')} className={`rounded-pill px-3 py-1 ${view === 'agenda' ? 'bg-coral text-cream' : 'text-ink-canvas-muted'}`}>
                Agenda
              </button>
              <button onClick={() => setView('month')} className={`rounded-pill px-3 py-1 ${view === 'month' ? 'bg-coral text-cream' : 'text-ink-canvas-muted'}`}>
                Month
              </button>
            </div>
            <button onClick={onCreateNew} className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream shadow-soft">
              + New Event
            </button>
          </div>
        </div>

        {view === 'month' && (
          <MonthGrid
            cursor={monthCursor}
            events={events}
            selectedDay={selectedDay}
            onSelectDay={setSelectedDay}
            onPrevMonth={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))}
            onNextMonth={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))}
          />
        )}

        {loading ? (
          <p className="mt-6 text-center text-sm text-ink-canvas-muted">Loading events…</p>
        ) : dayFiltered.length === 0 ? (
          <div className="mt-6 rounded-lg bg-card p-8 text-center shadow-card">
            <p className="text-2xl">📅</p>
            <p className="mt-2 font-display text-lg text-ink-card">Nothing scheduled</p>
            <p className="mt-1 text-sm text-ink-card-muted">Create an event, or turn a message into one from the chat.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {dayFiltered.map((event) => {
              const myRsvp = event.participants.find((p) => p.userId === myUserId)?.rsvp ?? 'PENDING';
              const start = new Date(event.startAt);
              return (
                <div key={event.id} className="rounded-md bg-card p-4 shadow-soft">
                  <button onClick={() => onOpenEvent(event.id)} className="block w-full text-left">
                    <div className="flex items-center gap-2">
                      <span>📅</span>
                      <DecryptedText
                        ciphertext={event.titleCiphertext}
                        sessionRef={event.sessionRef}
                        e2ee={e2ee}
                        className="font-medium text-ink-card"
                      />
                    </div>
                    <p className="mt-1 text-xs text-ink-card-muted">
                      {start.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} ·{' '}
                      {start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <p className="mt-1 text-xs text-ink-card-muted">👥 {event.participants.length} participants</p>
                  </button>
                  <div className="mt-3 flex gap-2">
                    {(['GOING', 'MAYBE', 'DECLINED'] as Rsvp[]).map((status) => (
                      <button
                        key={status}
                        onClick={() => onRsvp(event.id, status)}
                        className={`rounded-pill px-3 py-1 text-xs font-medium ${
                          myRsvp === status ? 'bg-coral text-cream' : 'bg-card-alt text-ink-card'
                        }`}
                      >
                        {status === 'GOING' ? 'Going' : status === 'MAYBE' ? 'Maybe' : "Can't go"}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MonthGrid({
  cursor,
  events,
  selectedDay,
  onSelectDay,
  onPrevMonth,
  onNextMonth,
}: {
  cursor: Date;
  events: WireEventWithParticipants[];
  selectedDay: Date | null;
  onSelectDay: (d: Date | null) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
}) {
  const firstWeekday = startOfMonth(cursor).getDay();
  const total = daysInMonth(cursor);
  const cells: (Date | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: total }, (_, i) => new Date(cursor.getFullYear(), cursor.getMonth(), i + 1))];

  return (
    <div className="mt-4 rounded-lg bg-card p-4 shadow-soft">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={onPrevMonth} className="text-ink-card-muted hover:text-ink-card">‹</button>
        <p className="text-sm font-medium text-ink-card">{cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })}</p>
        <button onClick={onNextMonth} className="text-ink-card-muted hover:text-ink-card">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-ink-card-muted">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
        {cells.map((day, i) => {
          const hasEvent = day && events.some((e) => sameDay(new Date(e.startAt), day));
          const isSelected = day && selectedDay && sameDay(day, selectedDay);
          return (
            <button
              key={i}
              disabled={!day}
              onClick={() => day && onSelectDay(isSelected ? null : day)}
              className={`aspect-square rounded-sm text-xs ${
                isSelected ? 'bg-coral text-cream' : day ? 'text-ink-card hover:bg-card-alt' : ''
              }`}
            >
              {day?.getDate()}
              {hasEvent && !isSelected && <span className="mx-auto mt-0.5 block h-1 w-1 rounded-pill bg-coral" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
