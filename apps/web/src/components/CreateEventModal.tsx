'use client';

import { useState, type FormEvent } from 'react';

export function CreateEventModal({
  defaultTitle = '',
  onCreate,
  onClose,
}: {
  defaultTitle?: string;
  onCreate: (input: {
    title: string;
    description?: string;
    date: string;
    startTime: string;
    endTime?: string;
    location?: string;
    onlineLink?: string;
  }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [onlineLink, setOnlineLink] = useState('');
  const [description, setDescription] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !date || !startTime) return;
    onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      date,
      startTime,
      endTime: endTime || undefined,
      location: location.trim() || undefined,
      onlineLink: onlineLink.trim() || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg bg-card p-6 shadow-card"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-ink-card">Create Event</h3>
          <button type="button" onClick={onClose} className="text-ink-card-muted hover:opacity-70">
            ✕
          </button>
        </div>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Event title"
          className="mt-4 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          autoFocus
        />

        <div className="mt-3 flex gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="flex-1 rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          />
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="flex-1 rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          />
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            placeholder="End"
            className="flex-1 rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          />
        </div>

        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="📍 Location (optional)"
          className="mt-3 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
        />
        <input
          value={onlineLink}
          onChange={(e) => setOnlineLink(e.target.value)}
          placeholder="🔗 Online meeting link (optional)"
          className="mt-2 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={2}
          className="mt-2 w-full resize-none rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
        />

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-pill bg-card-alt py-2 text-sm text-ink-card">
            Cancel
          </button>
          <button type="submit" className="flex-1 rounded-pill bg-coral py-2 text-sm font-medium text-cream">
            Create Event
          </button>
        </div>
      </form>
    </div>
  );
}
