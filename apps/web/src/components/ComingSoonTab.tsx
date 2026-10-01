'use client';

const COPY: Record<string, { icon: string; title: string; body: string }> = {
  tasks: { icon: '📋', title: 'Tasks are on the way', body: 'A board for tasks created from messages or added manually lands in the next update.' },
  schedule: { icon: '📅', title: 'Schedule is on the way', body: 'A shared calendar with events, RSVPs, and reminders lands in the next update.' },
  files: { icon: '📁', title: 'Files are on the way', body: 'A dedicated file dashboard with folders and search lands in the next update.' },
  notes: { icon: '📝', title: 'Notes are on the way', body: 'Shared, encrypted workspace notes land in the next update.' },
  decisions: { icon: '📌', title: 'Decisions are on the way', body: 'A log of decisions your team has made lands in the next update.' },
  polls: { icon: '📊', title: 'Polls are on the way', body: 'Quick polls for group decisions land in the next update.' },
};

export function ComingSoonTab({ tab }: { tab: string }) {
  const copy = COPY[tab] ?? { icon: '✨', title: 'Coming soon', body: '' };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-canvas text-center">
      <span className="text-4xl">{copy.icon}</span>
      <p className="font-display text-lg text-ink-canvas">{copy.title}</p>
      <p className="max-w-xs text-sm text-ink-canvas-muted">{copy.body}</p>
    </div>
  );
}
