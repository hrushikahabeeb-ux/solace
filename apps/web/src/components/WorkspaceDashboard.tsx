'use client';
import type { E2EEEngine } from '../lib/e2ee';

import type { WorkspaceDashboard as WorkspaceDashboardData } from '../lib/api';
import { DecryptedText } from './DecryptedText';
import type { WorkspaceTab } from './WorkspaceTabs';

export function WorkspaceDashboard({
  data,
  loading,
  e2ee,
  onSwitchTab,
}: {
  data: WorkspaceDashboardData | null;
  loading: boolean;
  e2ee: E2EEEngine | null;
  onSwitchTab: (tab: WorkspaceTab) => void;
}) {
  if (loading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center bg-canvas">
        <p className="text-ink-canvas-muted">Loading workspace…</p>
      </div>
    );
  }

  const { workspace, memberCount, taskCounts, fileCount, upcomingEvents, recentTasks } = data;
  const totalTasks = taskCounts.TODO + taskCounts.IN_PROGRESS + taskCounts.DONE;
  const isEmpty = totalTasks === 0 && upcomingEvents.length === 0 && fileCount === 0;

  return (
    <div className="flex-1 overflow-y-auto bg-canvas p-6">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-lg bg-card p-6 shadow-card">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{workspace.emoji ?? '🚀'}</span>
            <div>
              <h2 className="font-display text-xl text-ink-card">{workspace.name}</h2>
              <p className="text-xs text-ink-card-muted">{memberCount} members</p>
            </div>
          </div>
          {workspace.description && <p className="mt-3 text-sm text-ink-card-muted">{workspace.description}</p>}
        </div>

        {isEmpty ? (
          <div className="mt-6 rounded-lg bg-card p-8 text-center shadow-card">
            <p className="text-2xl">✨</p>
            <p className="mt-2 font-display text-lg text-ink-card">Your workspace is ready!</p>
            <p className="mt-1 text-sm text-ink-card-muted">
              Start by creating a task, scheduling an event, or uploading a file.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button onClick={() => onSwitchTab('tasks')} className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream">
                📋 New task
              </button>
              <button onClick={() => onSwitchTab('schedule')} className="rounded-pill bg-card-alt px-4 py-2 text-sm text-ink-card">
                📅 New event
              </button>
              <button onClick={() => onSwitchTab('files')} className="rounded-pill bg-card-alt px-4 py-2 text-sm text-ink-card">
                📁 Add file
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-4 gap-3">
              <StatCard label="Tasks" value={totalTasks} onClick={() => onSwitchTab('tasks')} />
              <StatCard label="In progress" value={taskCounts.IN_PROGRESS} onClick={() => onSwitchTab('tasks')} />
              <StatCard label="Events" value={upcomingEvents.length} onClick={() => onSwitchTab('schedule')} />
              <StatCard label="Files" value={fileCount} onClick={() => onSwitchTab('files')} />
            </div>

            {upcomingEvents.length > 0 && (
              <Section title="Upcoming">
                {upcomingEvents.map((event) => (
                  <div key={event.id} className="flex items-center gap-3 rounded-sm bg-card-alt px-3 py-2 text-sm">
                    <span>📅</span>
                    <div>
                      <DecryptedText
                        ciphertext={event.titleCiphertext}
                        sessionRef={event.sessionRef}
                        e2ee={e2ee}
                        className="block font-medium text-ink-card"
                      />
                      <span className="text-xs text-ink-card-muted">
                        {new Date(event.startAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {recentTasks.length > 0 && (
              <Section title="Tasks">
                {recentTasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-2 rounded-sm bg-card-alt px-3 py-2 text-sm">
                    <span>{task.status === 'DONE' ? '\u2611' : '\u2610'}</span>
                    <DecryptedText
                      ciphertext={task.titleCiphertext}
                      sessionRef={task.sessionRef}
                      e2ee={e2ee}
                      className="flex-1 text-ink-card"
                    />
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-md bg-card px-3 py-3 text-left shadow-soft hover:opacity-90">
      <p className="font-display text-2xl text-ink-card">{value}</p>
      <p className="text-xs text-ink-card-muted">{label}</p>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-canvas-muted">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
