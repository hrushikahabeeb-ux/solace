'use client';

export type WorkspaceTab = 'chat' | 'dashboard' | 'tasks' | 'schedule' | 'files' | 'notes' | 'decisions' | 'polls';

const TABS: { id: WorkspaceTab; label: string; icon: string }[] = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'dashboard', label: 'Home', icon: '🏠' },
  { id: 'tasks', label: 'Tasks', icon: '📋' },
  { id: 'schedule', label: 'Schedule', icon: '📅' },
  { id: 'files', label: 'Files', icon: '📁' },
  { id: 'notes', label: 'Notes', icon: '📝' },
  { id: 'decisions', label: 'Decisions', icon: '📌' },
  { id: 'polls', label: 'Polls', icon: '📊' },
];

/**
 * Chat stays first and is always the tab you land on (per the product philosophy:
 * "the chat experience must remain the primary experience") — everything else is
 * additional, discoverable, and one click away, never in front of it.
 */
export function WorkspaceTabs({ active, onChange }: { active: WorkspaceTab; onChange: (tab: WorkspaceTab) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-on-canvas bg-canvas-alt px-4">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
            active === tab.id
              ? 'border-coral font-medium text-ink-canvas'
              : 'border-transparent text-ink-canvas-muted hover:text-ink-canvas'
          }`}
        >
          <span>{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </div>
  );
}
