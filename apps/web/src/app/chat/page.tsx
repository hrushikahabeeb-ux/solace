'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, ApiError } from '../../lib/authSession';
import { api, type ConversationSummary, type ConversationMemberSummary, type WireMessage, type Workspace, type WorkspaceDashboard as WorkspaceDashboardData, type WireTaskWithDetails, type TaskActivityEntry, type WireEventWithParticipants, type Note, type Decision, type Poll, type WorkspaceFile, type StorageSummary, type Folder, type FileCategory } from '../../lib/api';
import { RealtimeClient } from '../../lib/realtime';
import { encodeEnvelope, decodeEnvelope, type MessageEnvelope } from '../../lib/messageEnvelope';
import { uploadEncryptedMedia, uploadEncryptedVoice } from '../../lib/mediaPipeline';
import {
  decryptMessage,
  describeDecryptFailure,
  encryptForConversation,
  encryptForWorkspace,
  parseSessionRef,
} from '../../lib/e2ee';
import { ConversationList } from '../../components/ConversationList';
import { MessageThread, type DisplayMessage } from '../../components/MessageThread';
import { useCall, type CallLogEntry } from '../../components/CallProvider';
import { describeCallLog } from '../../lib/callLog';
import { MembersPanel } from '../../components/MembersPanel';
import { CreateWorkspaceModal } from '../../components/CreateWorkspaceModal';
import { WorkspaceTabs, type WorkspaceTab } from '../../components/WorkspaceTabs';
import { WorkspaceDashboard } from '../../components/WorkspaceDashboard';
import { ComingSoonTab } from '../../components/ComingSoonTab';
import { TaskBoard } from '../../components/TaskBoard';
import { CreateTaskModal } from '../../components/CreateTaskModal';
import { TaskDetailPanel } from '../../components/TaskDetailPanel';
import { TaskCelebration } from '../../components/TaskCelebration';
import { CalendarView } from '../../components/CalendarView';
import { CreateEventModal } from '../../components/CreateEventModal';
import { NotesTab } from '../../components/NotesTab';
import { DecisionsTab } from '../../components/DecisionsTab';
import { PollsTab } from '../../components/PollsTab';
import { FilesTab } from '../../components/FilesTab';
import type { GifResult } from '../../components/StickerGifPicker';
import type { MediaPayload } from '../../components/MediaBubble';

interface DisplayBase {
  id: string;
  senderId: string;
  mine: boolean;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replyToId: string | null;
}

function toDisplayMessage(base: DisplayBase, envelope: MessageEnvelope | null, lockedReason?: string): DisplayMessage {
  const common = {
    ...base,
    reactions: {} as Record<string, string[]>,
    starred: false,
    status: (base.mine ? 'sent' : null) as DisplayMessage['status'],
  };

  if (!envelope) {
    return { ...common, text: lockedReason ?? '\u26A0\uFE0F Could not decrypt this message' };
  }
  if (envelope.kind === 'text') {
    const text = envelope.forwardedFromDisplayName
      ? `\u21AA Forwarded from ${envelope.forwardedFromDisplayName}\n${envelope.text}`
      : envelope.text;
    return { ...common, text };
  }
  if (envelope.kind === 'sticker') {
    return { ...common, text: envelope.emoji, sticker: { emoji: envelope.emoji } };
  }
  if (envelope.kind === 'gif') {
    return { ...common, text: 'GIF', gif: { url: envelope.url, previewUrl: envelope.previewUrl } };
  }
  if (envelope.kind === 'call') {
    const call = { media: envelope.media, outcome: envelope.outcome, durationSeconds: envelope.durationSeconds };
    return { ...common, text: describeCallLog(base.mine, call), call };
  }
  const media: MediaPayload = {
    mediaType: envelope.mediaType,
    filename: envelope.filename,
    mimeType: envelope.mimeType,
    sizeBytes: envelope.sizeBytes,
    keyMaterial: envelope.keyMaterial,
    thumbnailBase64: envelope.thumbnailBase64,
    durationSeconds: envelope.durationSeconds,
  };
  return { ...common, text: envelope.filename, media };
}

export default function ChatShellPage() {
  const { user, accessToken, e2ee, status, logout } = useAuth();
  const router = useRouter();
  const { registerCallLogger } = useCall();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, DisplayMessage[]>>({});
  const [typingByConversation, setTypingByConversation] = useState<Record<string, boolean>>({});
  const [pinnedByConversation, setPinnedByConversation] = useState<Record<string, string | null>>({});
  const [hasMoreByConversation, setHasMoreByConversation] = useState<Record<string, boolean>>({});
  const [replyTarget, setReplyTarget] = useState<DisplayMessage | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [startChatError, setStartChatError] = useState<string | null>(null);
  const [startingChatBusy, setStartingChatBusy] = useState(false);
  const [showStarred, setShowStarred] = useState(false);
  const [starredItems, setStarredItems] = useState<(DisplayMessage & { conversationId: string })[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [membersPanelData, setMembersPanelData] = useState<ConversationMemberSummary[]>([]);
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const [blockedList, setBlockedList] = useState<{ id: string; username: string; displayName: string }[]>([]);
  const [showBlocked, setShowBlocked] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  const [dashboard, setDashboard] = useState<WorkspaceDashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [tasks, setTasks] = useState<WireTaskWithDetails[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskActivity, setTaskActivity] = useState<TaskActivityEntry[]>([]);
  const [celebrationTask, setCelebrationTask] = useState<WireTaskWithDetails | null>(null);
  const [events, setEvents] = useState<WireEventWithParticipants[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  const [pendingEventTitle, setPendingEventTitle] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [decisionsLoading, setDecisionsLoading] = useState(false);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [pollsLoading, setPollsLoading] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileCategory, setFileCategory] = useState<FileCategory | 'all'>('all');
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);

  const realtimeRef = useRef<RealtimeClient | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  // Always points at the latest logCall (defined below), so the logger registered once with
  // CallProvider never runs against stale conversations or state.
  const logCallRef = useRef<(entry: CallLogEntry) => Promise<void>>(async () => undefined);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Finished calls are recorded in the thread by the caller's client (see lib/callLog.ts).
  useEffect(
    () =>
      registerCallLogger((entry) => {
        void logCallRef.current(entry).catch(() => undefined);
      }),
    [registerCallLogger],
  );

  useEffect(() => {
    if (status === 'ready' && !user) router.replace('/');
  }, [status, user, router]);

  useEffect(() => {
    if (!accessToken) return;
    api
      .listConversations(accessToken)
      .then((res) => setConversations(res.conversations))
      .catch(() => undefined)
      .finally(() => setConversationsLoading(false));
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    api
      .listBlocked(accessToken)
      .then((res) => {
        setBlockedUserIds(res.blocked.map((b) => b.id));
        setBlockedList(res.blocked);
      })
      .catch(() => undefined);
  }, [accessToken]);

  useEffect(() => {
    setActiveTab('chat');
    setDashboard(null);
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!selectedId || !accessToken || !conversation || conversation.type === 'DIRECT') {
      setWorkspace(null);
      return;
    }
    api
      .getWorkspaceForConversation(selectedId, accessToken)
      .then((res) => setWorkspace(res.workspace))
      .catch(() => setWorkspace(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally not re-running on every conversations[] change
  }, [selectedId, accessToken]);

  useEffect(() => {
    if (activeTab !== 'dashboard' || !workspace || !accessToken) return;
    setDashboardLoading(true);
    api
      .getWorkspaceDashboard(workspace.id, accessToken)
      .then(setDashboard)
      .catch(() => undefined)
      .finally(() => setDashboardLoading(false));
  }, [activeTab, workspace, accessToken]);

  useEffect(() => {
    setTasks([]);
  }, [workspace?.id]);

  useEffect(() => {
    if (activeTab !== 'tasks' || !workspace || !accessToken) return;
    setTasksLoading(true);
    api
      .listTasks(workspace.id, accessToken)
      .then((res) => setTasks(res.tasks))
      .catch(() => undefined)
      .finally(() => setTasksLoading(false));
  }, [activeTab, workspace, accessToken]);

  useEffect(() => {
    setEvents([]);
  }, [workspace?.id]);

  useEffect(() => {
    if (activeTab !== 'schedule' || !workspace || !accessToken) return;
    setEventsLoading(true);
    api
      .listEvents(workspace.id, accessToken)
      .then((res) => setEvents(res.events))
      .catch(() => undefined)
      .finally(() => setEventsLoading(false));
  }, [activeTab, workspace, accessToken]);

  useEffect(() => {
    setNotes([]);
    setDecisions([]);
    setPolls([]);
  }, [workspace?.id]);

  useEffect(() => {
    if (activeTab !== 'notes' || !workspace || !accessToken) return;
    setNotesLoading(true);
    api
      .listNotes(workspace.id, accessToken)
      .then((res) => setNotes(res.notes))
      .catch(() => undefined)
      .finally(() => setNotesLoading(false));
  }, [activeTab, workspace, accessToken]);

  useEffect(() => {
    if (activeTab !== 'decisions' || !workspace || !accessToken) return;
    setDecisionsLoading(true);
    api
      .listDecisions(workspace.id, accessToken)
      .then((res) => setDecisions(res.decisions))
      .catch(() => undefined)
      .finally(() => setDecisionsLoading(false));
  }, [activeTab, workspace, accessToken]);

  useEffect(() => {
    if (activeTab !== 'polls' || !workspace || !accessToken) return;
    setPollsLoading(true);
    api
      .listPolls(workspace.id, accessToken)
      .then((res) => setPolls(res.polls))
      .catch(() => undefined)
      .finally(() => setPollsLoading(false));
  }, [activeTab, workspace, accessToken]);

  useEffect(() => {
    setFiles([]);
    setFolders([]);
    setStorageSummary(null);
  }, [workspace?.id]);

  useEffect(() => {
    if (activeTab !== 'files' || !workspace || !accessToken) return;
    setFilesLoading(true);
    Promise.all([
      api.listFiles(workspace.id, accessToken, fileCategory === 'all' ? undefined : { category: fileCategory }),
      api.getStorageSummary(workspace.id, accessToken),
      api.listFolders(workspace.id, accessToken),
    ])
      .then(([filesRes, storageRes, foldersRes]) => {
        setFiles(filesRes.files);
        setStorageSummary(storageRes);
        setFolders(foldersRes.folders);
      })
      .catch(() => undefined)
      .finally(() => setFilesLoading(false));
  }, [activeTab, workspace, accessToken, fileCategory]);

  const updateMessage = useCallback((conversationId: string, messageId: string, patch: Partial<DisplayMessage>) => {
    setMessagesByConversation((prev) => {
      const list = prev[conversationId];
      if (!list) return prev;
      return { ...prev, [conversationId]: list.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) };
    });
  }, []);

  const appendMessage = useCallback((conversationId: string, message: DisplayMessage) => {
    setMessagesByConversation((prev) => ({ ...prev, [conversationId]: [...(prev[conversationId] ?? []), message] }));
  }, []);

  const decryptWire = useCallback(
    async (wire: WireMessage, mine: boolean): Promise<DisplayMessage> => {
      const base: DisplayBase = {
        id: wire.id,
        senderId: wire.senderId,
        mine,
        createdAt: wire.createdAt,
        editedAt: wire.editedAt,
        deletedAt: wire.deletedAt,
        replyToId: wire.replyToId,
      };

      if (wire.deletedAt) return toDisplayMessage(base, { kind: 'text', text: '' });

      if (!e2ee) {
        return toDisplayMessage(base, null, '\uD83D\uDD12 Locked \u2014 log in again to decrypt');
      }

      // Decryption is stateless: it is safe to run for every message in parallel, to
      // repeat, and to run for messages this device itself sent (each message carries a
      // copy of its key for the sender's own devices).
      try {
        const result = await decryptMessage(e2ee, {
          conversationId: wire.conversationId,
          ciphertext: wire.ciphertext,
          senderUserId: wire.senderId,
        });
        if (!result.ok) return toDisplayMessage(base, null, describeDecryptFailure(result.reason));
        return toDisplayMessage(base, decodeEnvelope(result.plaintext));
      } catch {
        return toDisplayMessage(base, null);
      }
    },
    [e2ee],
  );

  const openConversation = useCallback(
    async (conversationId: string) => {
      setSelectedId(conversationId);
      setSearchQuery('');
      if (!accessToken) return;

      api
        .listPins(conversationId, accessToken)
        .then((res) => setPinnedByConversation((prev) => ({ ...prev, [conversationId]: res.pins[0]?.messageId ?? null })))
        .catch(() => undefined);

      if (messagesByConversation[conversationId]) return;

      const { messages } = await api.listMessages(conversationId, accessToken);
      const decrypted = await Promise.all(messages.map((m) => decryptWire(m, m.senderId === user?.id)));
      setMessagesByConversation((prev) => ({ ...prev, [conversationId]: decrypted }));
      setHasMoreByConversation((prev) => ({ ...prev, [conversationId]: messages.length >= 50 }));

      messages
        .filter((m) => m.senderId !== user?.id)
        .forEach((m) => api.sendReceipt(conversationId, m.id, 'READ', accessToken).catch(() => undefined));
    },
    [accessToken, decryptWire, messagesByConversation, user?.id],
  );

  const loadOlderMessages = useCallback(
    async (conversationId: string) => {
      if (!accessToken) return;
      const list = messagesByConversation[conversationId] ?? [];
      const oldest = list[0];
      if (!oldest) return;

      const { messages } = await api.listMessages(conversationId, accessToken, oldest.createdAt);
      if (messages.length === 0) {
        setHasMoreByConversation((prev) => ({ ...prev, [conversationId]: false }));
        return;
      }
      const decrypted = await Promise.all(messages.map((m) => decryptWire(m, m.senderId === user?.id)));
      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: [...decrypted, ...(prev[conversationId] ?? [])],
      }));
      setHasMoreByConversation((prev) => ({ ...prev, [conversationId]: messages.length >= 50 }));
    },
    [accessToken, decryptWire, messagesByConversation, user?.id],
  );

  useEffect(() => {
    if (!accessToken) return;
    const client = new RealtimeClient(accessToken);
    realtimeRef.current = client;
    client.connect();

    const unsubscribe = client.on((event) => {
      switch (event.type) {
        case 'message.new': {
          const isOpen = event.conversationId === selectedIdRef.current;
          decryptWire(event.message, false).then((display) => appendMessage(event.conversationId, display));
          api
            .sendReceipt(event.conversationId, event.message.id, isOpen ? 'READ' : 'DELIVERED', accessToken)
            .catch(() => undefined);
          break;
        }
        case 'message.receipt': {
          updateMessage(event.conversationId, event.messageId, { status: event.status === 'READ' ? 'read' : 'delivered' });
          break;
        }
        case 'typing': {
          setTypingByConversation((prev) => ({ ...prev, [event.conversationId]: event.state === 'start' }));
          break;
        }
        case 'message.edited': {
          decryptWire(event.message, event.message.senderId === user?.id).then((display) =>
            updateMessage(event.conversationId, event.message.id, { text: display.text, editedAt: display.editedAt }),
          );
          break;
        }
        case 'message.deleted': {
          updateMessage(event.conversationId, event.messageId, {
            deletedAt: new Date().toISOString(),
            text: '',
            media: undefined,
          });
          break;
        }
        case 'message.reaction': {
          if (event.userId === user?.id) break;
          setMessagesByConversation((prev) => {
            const list = prev[event.conversationId];
            if (!list) return prev;
            return {
              ...prev,
              [event.conversationId]: list.map((m) => {
                if (m.id !== event.messageId) return m;
                const current = m.reactions[event.emoji] ?? [];
                const next =
                  event.action === 'added'
                    ? [...new Set([...current, event.userId])]
                    : current.filter((id) => id !== event.userId);
                const reactions = { ...m.reactions, [event.emoji]: next };
                if (next.length === 0) delete reactions[event.emoji];
                return { ...m, reactions };
              }),
            };
          });
          break;
        }
        case 'message.pinned': {
          setPinnedByConversation((prev) => ({ ...prev, [event.conversationId]: event.messageId }));
          break;
        }
        case 'message.unpinned': {
          setPinnedByConversation((prev) =>
            prev[event.conversationId] === event.messageId ? { ...prev, [event.conversationId]: null } : prev,
          );
          break;
        }
        case 'disappearing.changed': {
          setConversations((prev) =>
            prev.map((c) => (c.id === event.conversationId ? { ...c, disappearingSeconds: event.seconds } : c)),
          );
          break;
        }
        case 'task.created': {
          setTasks((prev) => (workspace?.id === event.workspaceId ? [event.task, ...prev] : prev));
          break;
        }
        case 'task.updated': {
          setTasks((prev) => (workspace?.id === event.workspaceId ? prev.map((t) => (t.id === event.task.id ? event.task : t)) : prev));
          break;
        }
        case 'task.deleted': {
          setTasks((prev) => (workspace?.id === event.workspaceId ? prev.filter((t) => t.id !== event.taskId) : prev));
          break;
        }
        case 'subtask.created': {
          setTasks((prev) =>
            prev.map((t) => (t.id === event.taskId ? { ...t, subtasks: [...t.subtasks, event.subtask] } : t)),
          );
          break;
        }
        case 'subtask.updated': {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === event.taskId ? { ...t, subtasks: t.subtasks.map((s) => (s.id === event.subtask.id ? event.subtask : s)) } : t,
            ),
          );
          break;
        }
        case 'subtask.deleted': {
          setTasks((prev) =>
            prev.map((t) => (t.id === event.taskId ? { ...t, subtasks: t.subtasks.filter((s) => s.id !== event.subtaskId) } : t)),
          );
          break;
        }
        case 'task.comment': {
          setTaskActivity((prev) => (selectedTaskId === event.taskId ? [...prev, event.entry] : prev));
          break;
        }
        case 'event.created': {
          setEvents((prev) => (workspace?.id === event.workspaceId ? [...prev, event.event].sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt)) : prev));
          break;
        }
        case 'event.updated': {
          setEvents((prev) => (workspace?.id === event.workspaceId ? prev.map((e) => (e.id === event.event.id ? event.event : e)) : prev));
          break;
        }
        case 'event.deleted': {
          setEvents((prev) => (workspace?.id === event.workspaceId ? prev.filter((e) => e.id !== event.eventId) : prev));
          break;
        }
        case 'event.rsvp': {
          setEvents((prev) =>
            prev.map((e) =>
              e.id === event.eventId
                ? { ...e, participants: e.participants.map((p) => (p.userId === event.participant.userId ? event.participant : p)) }
                : e,
            ),
          );
          break;
        }
        case 'note.created': {
          setNotes((prev) => (workspace?.id === event.workspaceId ? [event.note, ...prev] : prev));
          break;
        }
        case 'note.updated': {
          setNotes((prev) => (workspace?.id === event.workspaceId ? prev.map((n) => (n._id === event.note._id ? event.note : n)) : prev));
          break;
        }
        case 'note.deleted': {
          setNotes((prev) => (workspace?.id === event.workspaceId ? prev.filter((n) => n._id !== event.noteId) : prev));
          break;
        }
        case 'decision.created': {
          setDecisions((prev) => (workspace?.id === event.workspaceId ? [event.decision, ...prev] : prev));
          break;
        }
        case 'decision.deleted': {
          setDecisions((prev) => (workspace?.id === event.workspaceId ? prev.filter((d) => d._id !== event.decisionId) : prev));
          break;
        }
        case 'poll.created': {
          setPolls((prev) => (workspace?.id === event.workspaceId ? [event.poll, ...prev] : prev));
          break;
        }
        case 'poll.voted': {
          setPolls((prev) => (workspace?.id === event.workspaceId ? prev.map((p) => (p._id === event.poll._id ? event.poll : p)) : prev));
          break;
        }
        case 'poll.deleted': {
          setPolls((prev) => (workspace?.id === event.workspaceId ? prev.filter((p) => p._id !== event.pollId) : prev));
          break;
        }
      }
    });

    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, [accessToken, appendMessage, decryptWire, updateMessage, user?.id, workspace, selectedTaskId]);

  async function handleStartChat(username: string) {
    if (!accessToken) return;
    setStartingChatBusy(true);
    setStartChatError(null);
    try {
      const result = await api.createDirectConversation(username, accessToken);
      setConversations((prev) => {
        if (prev.some((c) => c.id === result.id)) return prev;
        return [{ id: result.id, type: 'DIRECT', title: null, members: [result.peer], lastMessage: null }, ...prev];
      });
      setSelectedId(result.id);
    } catch (err) {
      setStartChatError(
        err instanceof ApiError && err.code === 'user_not_found' ? 'No user with that username.' : 'Could not start chat.',
      );
    } finally {
      setStartingChatBusy(false);
    }
  }

  async function handleCreateGroup(title: string, usernames: string[]) {
    if (!accessToken || !user) return;
    try {
      const result = await api.createGroup(title, usernames, accessToken);
      const others = result.members.filter((m) => m.id !== user.id);
      const mine = result.members.find((m) => m.id === user.id);
      setConversations((prev) => [
        { id: result.id, type: 'GROUP', title: result.title, myRole: mine?.role, members: others, lastMessage: null },
        ...prev,
      ]);
      setSelectedId(result.id);
    } catch {
      setStartChatError('Could not create group \u2014 check the usernames.');
    }
  }

  /** Encrypts an envelope for every current member of the conversation (all of their
   *  devices, plus this user's own other devices). One code path serves direct chats and
   *  groups: there is no session to establish and no room key to distribute. */
  async function encryptEnvelopeForConversation(
    conversation: ConversationSummary,
    envelope: MessageEnvelope,
  ): Promise<{ ciphertext: string; olmMessageType: number; sessionRef: string }> {
    if (!e2ee) throw new Error('Not ready to encrypt');
    return encryptForConversation(e2ee, {
      conversationId: conversation.id,
      memberUserIds: conversation.members.map((m) => m.id),
      plaintext: encodeEnvelope(envelope),
    });
  }

  async function sendEnvelopeTo(
    conversation: ConversationSummary,
    envelope: MessageEnvelope,
    options?: {
      replyToId?: string;
      media?: { storageKey: string; sizeBytes: number; contentHash: string; mimeTypeGuess: string };
      placeholderId?: string;
      /** Set false to send without adding the message to local state (default true). Used
       *  when the conversation's history is not loaded yet: appending would make
       *  openConversation believe it is loaded and skip fetching the real history. */
      appendLocally?: boolean;
    },
  ) {
    if (!accessToken) return;
    const { ciphertext, olmMessageType, sessionRef } = await encryptEnvelopeForConversation(conversation, envelope);

    const { message } = await api.sendMessage(
      conversation.id,
      {
        type: envelope.kind === 'media' ? 'MEDIA' : 'TEXT',
        ciphertext,
        olmMessageType,
        sessionRef,
        replyToId: options?.replyToId,
        media: options?.media,
      },
      accessToken,
    );

    const display = toDisplayMessage(
      {
        id: message.id,
        senderId: user!.id,
        mine: true,
        createdAt: message.createdAt,
        editedAt: null,
        deletedAt: null,
        replyToId: message.replyToId,
      },
      envelope,
    );

    if (options?.placeholderId) {
      setMessagesByConversation((prev) => {
        const list = prev[conversation.id];
        if (!list) return prev;
        return { ...prev, [conversation.id]: list.map((m) => (m.id === options.placeholderId ? display : m)) };
      });
    } else if (options?.appendLocally !== false) {
      appendMessage(conversation.id, display);
    }
  }

  async function logCall(entry: CallLogEntry) {
    const conversation = conversations.find((c) => c.id === entry.conversationId);
    if (!conversation) return;
    await sendEnvelopeTo(
      conversation,
      { kind: 'call', media: entry.media, outcome: entry.outcome, durationSeconds: entry.durationSeconds },
      { appendLocally: Boolean(messagesByConversation[conversation.id]) },
    );
  }
  logCallRef.current = logCall;

  async function handleSend(text: string, replyToId?: string) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation) return;
    await sendEnvelopeTo(conversation, { kind: 'text', text }, { replyToId });
  }

  async function handleSendFile(file: File, sendOriginalQuality: boolean) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;

    const placeholderId = `local-${crypto.randomUUID()}`;
    const isImage = file.type.startsWith('image/');
    appendMessage(conversation.id, {
      id: placeholderId,
      senderId: user!.id,
      mine: true,
      text: file.name,
      media: {
        mediaType: isImage ? 'image' : 'file',
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        uploadProgress: 0,
      },
      createdAt: new Date().toISOString(),
      status: 'sent',
      editedAt: null,
      deletedAt: null,
      replyToId: null,
      reactions: {},
      starred: false,
    });

    try {
      const { envelope, media } = await uploadEncryptedMedia(file, accessToken, {
        sendOriginalQuality,
        onProgress: (fraction) =>
          updateMessage(conversation.id, placeholderId, {
            media: {
              mediaType: isImage ? 'image' : 'file',
              filename: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              uploadProgress: fraction,
            },
          }),
      });
      await sendEnvelopeTo(conversation, envelope, { media, placeholderId });
    } catch {
      updateMessage(conversation.id, placeholderId, { text: '\u26A0\uFE0F Upload failed', media: undefined });
    }
  }

  async function handleSendVoice(blob: Blob, durationSeconds: number) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;

    const placeholderId = `local-${crypto.randomUUID()}`;
    appendMessage(conversation.id, {
      id: placeholderId,
      senderId: user!.id,
      mine: true,
      text: 'Voice message',
      media: {
        mediaType: 'voice',
        filename: 'voice-message',
        mimeType: blob.type || 'audio/webm',
        sizeBytes: blob.size,
        durationSeconds,
        uploadProgress: 0,
      },
      createdAt: new Date().toISOString(),
      status: 'sent',
      editedAt: null,
      deletedAt: null,
      replyToId: null,
      reactions: {},
      starred: false,
    });

    try {
      const { envelope, media } = await uploadEncryptedVoice(blob, durationSeconds, accessToken, (fraction) =>
        updateMessage(conversation.id, placeholderId, {
          media: {
            mediaType: 'voice',
            filename: 'voice-message',
            mimeType: blob.type,
            sizeBytes: blob.size,
            durationSeconds,
            uploadProgress: fraction,
          },
        }),
      );
      await sendEnvelopeTo(conversation, envelope, { media, placeholderId });
    } catch {
      updateMessage(conversation.id, placeholderId, { text: '\u26A0\uFE0F Upload failed', media: undefined });
    }
  }

  async function handleSendSticker(emoji: string) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation) return;
    await sendEnvelopeTo(conversation, { kind: 'sticker', emoji });
  }

  async function handleSendGif(gif: GifResult) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation) return;
    await sendEnvelopeTo(conversation, { kind: 'gif', url: gif.url, previewUrl: gif.previewUrl });
  }

  async function handleSearchGifs(query: string): Promise<GifResult[]> {
    if (!accessToken) return [];
    try {
      const { results } = await api.searchGifs(query, accessToken);
      return results;
    } catch {
      return [];
    }
  }

  /** Encryption happens right now, using the session state as it exists at this
   *  moment — the server only ever holds the resulting ciphertext and times its
   *  delivery (see jobs/sweeps.ts on the server for the caveat this implies). */
  async function handleScheduleSend(text: string, isoDateTime: string, replyToId?: string) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    const envelope: MessageEnvelope = { kind: 'text', text };
    const { ciphertext, olmMessageType, sessionRef } = await encryptEnvelopeForConversation(conversation, envelope);
    const { message } = await api.scheduleMessage(
      conversation.id,
      { type: 'TEXT', ciphertext, olmMessageType, sessionRef, replyToId, scheduledFor: isoDateTime },
      accessToken,
    );
    appendMessage(conversation.id, {
      id: message.id,
      senderId: user!.id,
      mine: true,
      text: `${text} (scheduled)`,
      createdAt: message.createdAt,
      status: 'sent',
      editedAt: null,
      deletedAt: null,
      replyToId: replyToId ?? null,
      reactions: {},
      starred: false,
    });
  }

  async function handleSetDisappearing(seconds: number | null) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    setConversations((prev) => prev.map((c) => (c.id === conversation.id ? { ...c, disappearingSeconds: seconds } : c)));
    await api.setDisappearing(conversation.id, seconds, accessToken).catch(() => undefined);
  }

  async function handleToggleBlock() {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || conversation.type !== 'DIRECT' || !accessToken) return;
    const peer = conversation.members[0];
    if (!peer) return;

    if (blockedUserIds.includes(peer.id)) {
      setBlockedUserIds((prev) => prev.filter((id) => id !== peer.id));
      setBlockedList((prev) => prev.filter((b) => b.id !== peer.id));
      await api.unblockUser(peer.id, accessToken).catch(() => undefined);
    } else {
      setBlockedUserIds((prev) => [...prev, peer.id]);
      setBlockedList((prev) => [...prev, { id: peer.id, username: peer.username, displayName: peer.displayName }]);
      await api.blockUser(peer.id, accessToken).catch(() => undefined);
    }
  }

  async function handleUnblockFromPanel(userId: string) {
    if (!accessToken) return;
    setBlockedUserIds((prev) => prev.filter((id) => id !== userId));
    setBlockedList((prev) => prev.filter((b) => b.id !== userId));
    await api.unblockUser(userId, accessToken).catch(() => undefined);
  }

  async function handleReport(messageId: string) {
    if (!accessToken || typeof window === 'undefined') return;
    const reason = window.prompt('Why are you reporting this message?');
    if (!reason) return;
    await api.reportMessage(messageId, reason, accessToken).catch(() => undefined);
  }

  async function handleCreateWorkspace(input: { name: string; emoji?: string; description?: string }) {
    if (!selectedId || !accessToken) return;
    try {
      const { workspace: created } = await api.createWorkspace(selectedId, input, accessToken);
      setWorkspace(created);
      setShowCreateWorkspace(false);
      setActiveTab('dashboard');
    } catch {
      setShowCreateWorkspace(false);
    }
  }

  /** Returns a function that encrypts one string for this conversation's members. */
  function workspaceEncryptor(engine: NonNullable<typeof e2ee>, conversation: ConversationSummary) {
    const memberUserIds = conversation.members.map((m) => m.id);
    return (plaintext: string) =>
      encryptForWorkspace(engine, { conversationId: conversation.id, memberUserIds, plaintext });
  }

  /** Shared by manual task creation and "create task from message" — both just need
   *  to encrypt a title (and optional description) for the workspace's members and post
   *  the result. */
  async function encryptTaskFields(title: string, description?: string) {
    if (!workspace || !selectedConversation || !e2ee) return null;
    const enc = workspaceEncryptor(e2ee, selectedConversation);
    const titleResult = await enc(title);
    const descriptionCiphertext = description ? (await enc(description)).ciphertext : undefined;
    return { titleCiphertext: titleResult.ciphertext, sessionRef: titleResult.sessionRef, descriptionCiphertext };
  }

  async function handleCreateTask(input: {
    title: string;
    description?: string;
    priority: 'LOW' | 'MEDIUM' | 'HIGH';
    dueDate?: string;
    assigneeId?: string;
    sourceMessageId?: string;
  }) {
    if (!workspace || !accessToken) return;
    const encrypted = await encryptTaskFields(input.title, input.description);
    if (!encrypted) return;
    const { task } = await api.createTask(
      workspace.id,
      { ...encrypted, priority: input.priority, dueDate: input.dueDate, assigneeId: input.assigneeId, sourceMessageId: input.sourceMessageId },
      accessToken,
    );
    setTasks((prev) => [task, ...prev]);
    setShowCreateTask(false);
  }

  async function handleCreateTaskFromMessage(message: DisplayMessage) {
    if (!workspace) {
      setShowCreateWorkspace(true);
      return;
    }
    const encrypted = await encryptTaskFields(message.text);
    if (!encrypted) return;
    const { task } = await api.createTask(workspace.id, { ...encrypted, sourceMessageId: message.id }, accessToken!);
    setTasks((prev) => [task, ...prev]);
    setActiveTab('tasks');
  }

  async function patchTask(taskId: string, patch: Parameters<typeof api.updateTask>[1]) {
    if (!accessToken) return;
    const previous = tasks.find((t) => t.id === taskId);
    const { task: updated } = await api.updateTask(taskId, patch, accessToken).catch(() => ({ task: null }));
    if (!updated) return;
    setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
    if (previous && previous.status !== 'DONE' && updated.status === 'DONE') {
      setCelebrationTask(updated);
    }
  }

  async function handleToggleTaskDone(task: WireTaskWithDetails) {
    await patchTask(task.id, { status: task.status === 'DONE' ? 'TODO' : 'DONE' });
  }

  async function handleOpenTask(taskId: string) {
    setSelectedTaskId(taskId);
    if (!accessToken) return;
    const { entries } = await api.listTaskActivity(taskId, accessToken).catch(() => ({ entries: [] }));
    setTaskActivity(entries);
  }

  async function handleAddSubtask(taskId: string, title: string) {
    if (!accessToken) return;
    const encrypted = await encryptTaskFields(title);
    if (!encrypted) return;
    const { subtask } = await api.createSubtask(taskId, { titleCiphertext: encrypted.titleCiphertext, sessionRef: encrypted.sessionRef }, accessToken);
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, subtasks: [...t.subtasks, subtask] } : t)));
  }

  async function handleToggleSubtask(taskId: string, subtaskId: string, done: boolean) {
    if (!accessToken) return;
    const { subtask } = await api.toggleSubtask(subtaskId, done, accessToken).catch(() => ({ subtask: null }));
    if (!subtask) return;
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subtaskId ? subtask : s)) } : t)),
    );
  }

  async function handleDeleteSubtask(taskId: string, subtaskId: string) {
    if (!accessToken) return;
    await api.deleteSubtask(subtaskId, accessToken).catch(() => undefined);
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, subtasks: t.subtasks.filter((s) => s.id !== subtaskId) } : t)));
  }

  async function handleAddTaskComment(taskId: string, text: string) {
    if (!workspace || !selectedConversation || !e2ee || !accessToken) return;
    const { ciphertext, sessionRef } = await workspaceEncryptor(e2ee, selectedConversation)(text);
    const { entry } = await api.addTaskComment(taskId, { ciphertext, sessionRef }, accessToken);
    setTaskActivity((prev) => [...prev, entry]);
  }

  async function handleDeleteTask(taskId: string) {
    if (!accessToken) return;
    await api.deleteTask(taskId, accessToken).catch(() => undefined);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    setSelectedTaskId(null);
  }

  /** Shared encryption step for event fields, mirroring encryptTaskFields. */
  async function encryptEventFields(fields: { title: string; description?: string; location?: string; onlineLink?: string }) {
    if (!workspace || !selectedConversation || !e2ee) return null;
    const enc = workspaceEncryptor(e2ee, selectedConversation);

    const titleResult = await enc(fields.title);
    const descriptionCiphertext = fields.description ? (await enc(fields.description)).ciphertext : undefined;
    const locationCiphertext = fields.location ? (await enc(fields.location)).ciphertext : undefined;
    const onlineLinkCiphertext = fields.onlineLink ? (await enc(fields.onlineLink)).ciphertext : undefined;
    return { titleCiphertext: titleResult.ciphertext, sessionRef: titleResult.sessionRef, descriptionCiphertext, locationCiphertext, onlineLinkCiphertext };
  }

  async function handleCreateEvent(input: {
    title: string;
    description?: string;
    date: string;
    startTime: string;
    endTime?: string;
    location?: string;
    onlineLink?: string;
  }) {
    if (!workspace || !accessToken) return;
    const encrypted = await encryptEventFields(input);
    if (!encrypted) return;
    const startAt = new Date(`${input.date}T${input.startTime}`).toISOString();
    const endAt = input.endTime ? new Date(`${input.date}T${input.endTime}`).toISOString() : undefined;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { event } = await api.createEvent(workspace.id, { ...encrypted, startAt, endAt, timezone }, accessToken);
    setEvents((prev) => [...prev, event].sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt)));
    setShowCreateEvent(false);
  }

  async function handleCreateEventFromMessage(message: DisplayMessage) {
    if (!workspace) {
      setShowCreateWorkspace(true);
      return;
    }
    // Deliberately does not attempt to parse a date/time out of the message text —
    // reliable natural-language date parsing is its own substantial feature. The
    // message text becomes the event title; the person fills in when.
    setShowCreateEvent(true);
    setPendingEventTitle(message.text);
  }

  async function handleRsvp(eventId: string, status: 'GOING' | 'MAYBE' | 'DECLINED') {
    if (!accessToken || !user) return;
    setEvents((prev) =>
      prev.map((e) =>
        e.id === eventId
          ? {
              ...e,
              participants: e.participants.some((p) => p.userId === user.id)
                ? e.participants.map((p) => (p.userId === user.id ? { ...p, rsvp: status } : p))
                : [...e.participants, { id: `local-${user.id}`, eventId, userId: user.id, rsvp: status, respondedAt: new Date().toISOString() }],
            }
          : e,
      ),
    );
    await api.rsvpToEvent(eventId, status, accessToken).catch(() => undefined);
  }

  /** Encrypts one or more plaintext strings for the workspace's members, used by
   *  notes/decisions/polls the same way encryptTaskFields/encryptEventFields are. */
  async function encryptWorkspaceStrings(...values: string[]): Promise<{ ciphertexts: string[]; sessionRef: string } | null> {
    if (!workspace || !selectedConversation || !e2ee) return null;
    const enc = workspaceEncryptor(e2ee, selectedConversation);
    const results = await Promise.all(values.map((plaintext) => enc(plaintext)));
    return { ciphertexts: results.map((r) => r.ciphertext), sessionRef: results[0].sessionRef };
  }

  async function handleCreateNote(title: string, body: string) {
    if (!workspace || !accessToken) return;
    const encrypted = await encryptWorkspaceStrings(title, body);
    if (!encrypted) return;
    const { note } = await api.createNote(
      workspace.id,
      { titleCiphertext: encrypted.ciphertexts[0], bodyCiphertext: encrypted.ciphertexts[1], sessionRef: encrypted.sessionRef },
      accessToken,
    );
    setNotes((prev) => [note, ...prev]);
  }

  async function handleUpdateNote(noteId: string, title: string, body: string) {
    if (!accessToken) return;
    const encrypted = await encryptWorkspaceStrings(title, body);
    if (!encrypted) return;
    const { note } = await api.updateNote(
      noteId,
      { titleCiphertext: encrypted.ciphertexts[0], bodyCiphertext: encrypted.ciphertexts[1], sessionRef: encrypted.sessionRef },
      accessToken,
    );
    setNotes((prev) => prev.map((n) => (n._id === noteId ? note : n)));
  }

  async function handleDeleteNote(noteId: string) {
    if (!accessToken) return;
    await api.deleteNote(noteId, accessToken).catch(() => undefined);
    setNotes((prev) => prev.filter((n) => n._id !== noteId));
  }

  async function handleCreateDecision(title: string, description?: string) {
    if (!workspace || !accessToken) return;
    const encrypted = description ? await encryptWorkspaceStrings(title, description) : await encryptWorkspaceStrings(title);
    if (!encrypted) return;
    const { decision } = await api.createDecision(
      workspace.id,
      { titleCiphertext: encrypted.ciphertexts[0], descriptionCiphertext: encrypted.ciphertexts[1], sessionRef: encrypted.sessionRef },
      accessToken,
    );
    setDecisions((prev) => [decision, ...prev]);
  }

  async function handleDeleteDecision(decisionId: string) {
    if (!accessToken) return;
    await api.deleteDecision(decisionId, accessToken).catch(() => undefined);
    setDecisions((prev) => prev.filter((d) => d._id !== decisionId));
  }

  async function handleCreatePoll(question: string, optionTexts: string[]) {
    if (!workspace || !accessToken) return;
    const encrypted = await encryptWorkspaceStrings(question, ...optionTexts);
    if (!encrypted) return;
    const [questionCiphertext, ...optionCiphertexts] = encrypted.ciphertexts;
    const { poll } = await api.createPoll(
      workspace.id,
      { questionCiphertext, sessionRef: encrypted.sessionRef, options: optionCiphertexts.map((textCiphertext) => ({ textCiphertext })) },
      accessToken,
    );
    setPolls((prev) => [poll, ...prev]);
  }

  async function handleCreatePollFromMessage(message: DisplayMessage) {
    if (!workspace) {
      setShowCreateWorkspace(true);
      return;
    }
    setActiveTab('polls');
    // The message becomes the poll question; options still need the person's input,
    // so this opens the tab rather than guessing at options from free text.
  }

  async function handleVotePoll(pollId: string, optionId: string) {
    if (!accessToken || !user) return;
    setPolls((prev) =>
      prev.map((p) =>
        p._id === pollId
          ? { ...p, votes: [...p.votes.filter((v) => v.userId !== user.id), { userId: user.id, optionId, votedAt: new Date().toISOString() }] }
          : p,
      ),
    );
    await api.voteOnPoll(pollId, optionId, accessToken).catch(() => undefined);
  }

  async function handleDeletePoll(pollId: string) {
    if (!accessToken) return;
    await api.deletePoll(pollId, accessToken).catch(() => undefined);
    setPolls((prev) => prev.filter((p) => p._id !== pollId));
  }

  /** Decrypts one file's envelope for display in the Files tab. Files are ordinary
   *  encrypted messages, so this is the same call chat uses, including for files this
   *  user sent themselves. */
  async function decryptFileEnvelope(file: WorkspaceFile) {
    if (!e2ee) return null;
    const conversationId = parseSessionRef(file.sessionRef)?.conversationId ?? selectedId;
    if (!conversationId) return null;
    const result = await decryptMessage(e2ee, { conversationId, ciphertext: file.ciphertext, senderUserId: file.senderId });
    return result.ok ? decodeEnvelope(result.plaintext) : null;
  }

  async function handleAssignFileFolder(messageId: string, folderId: string | null) {
    if (!accessToken) return;
    setFiles((prev) => prev.map((f) => (f.messageId === messageId ? { ...f, folderId } : f)));
    await api.assignFileToFolder(messageId, folderId, accessToken).catch(() => undefined);
  }

  async function handleCreateFolder(name: string) {
    if (!workspace || !accessToken) return;
    const encrypted = await encryptWorkspaceStrings(name);
    if (!encrypted) return;
    const { folder } = await api.createFolder(workspace.id, { nameCiphertext: encrypted.ciphertexts[0], sessionRef: encrypted.sessionRef }, accessToken);
    setFolders((prev) => [...prev, folder]);
  }

  async function handleDeleteFolder(folderId: string) {
    if (!accessToken) return;
    await api.deleteFolder(folderId, accessToken).catch(() => undefined);
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    setFiles((prev) => prev.map((f) => (f.folderId === folderId ? { ...f, folderId: null } : f)));
  }

  async function handleDeleteFile(messageId: string) {
    if (!accessToken) return;
    await api.deleteMessage(messageId, accessToken).catch(() => undefined);
    setFiles((prev) => prev.filter((f) => f.messageId !== messageId));
  }

  async function handleForward(messageId: string, targetConversationId: string) {
    const sourceConversation = conversations.find((c) => c.id === selectedId);
    const target = conversations.find((c) => c.id === targetConversationId);
    const original = selectedId ? messagesByConversation[selectedId]?.find((m) => m.id === messageId) : undefined;
    if (!sourceConversation || !target || !original || original.media) return;

    const forwardedFromDisplayName = original.mine
      ? user!.displayName
      : (sourceConversation.members[0]?.displayName ?? 'Unknown');
    await sendEnvelopeTo(target, { kind: 'text', text: original.text, forwardedFromDisplayName });
  }

  async function handleEdit(messageId: string, newText: string) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    const envelope: MessageEnvelope = { kind: 'text', text: newText };
    const { ciphertext, olmMessageType } = await encryptEnvelopeForConversation(conversation, envelope);
    const { message } = await api.editMessage(messageId, { ciphertext, olmMessageType }, accessToken);
    updateMessage(conversation.id, messageId, { text: newText, editedAt: message.editedAt });
  }

  async function handleDelete(messageId: string) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    await api.deleteMessage(messageId, accessToken);
    updateMessage(conversation.id, messageId, { deletedAt: new Date().toISOString(), text: '', media: undefined });
  }

  async function handleReact(messageId: string, emoji: string) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken || !user) return;
    setMessagesByConversation((prev) => {
      const list = prev[conversation.id];
      if (!list) return prev;
      return {
        ...prev,
        [conversation.id]: list.map((m) => {
          if (m.id !== messageId) return m;
          const current = m.reactions[emoji] ?? [];
          const mineReacted = current.includes(user.id);
          const next = mineReacted ? current.filter((id) => id !== user.id) : [...current, user.id];
          const reactions = { ...m.reactions, [emoji]: next };
          if (next.length === 0) delete reactions[emoji];
          return { ...m, reactions };
        }),
      };
    });
    await api.toggleReaction(messageId, emoji, accessToken).catch(() => undefined);
  }

  async function handleToggleStar(messageId: string, currentlyStarred: boolean) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    updateMessage(conversation.id, messageId, { starred: !currentlyStarred });
    if (currentlyStarred) await api.unstarMessage(messageId, accessToken).catch(() => undefined);
    else await api.starMessage(messageId, accessToken).catch(() => undefined);
  }

  async function handleTogglePin(messageId: string, currentlyPinned: boolean) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    setPinnedByConversation((prev) => ({ ...prev, [conversation.id]: currentlyPinned ? null : messageId }));
    if (currentlyPinned) await api.unpinMessage(messageId, accessToken).catch(() => undefined);
    else await api.pinMessage(messageId, accessToken).catch(() => undefined);
  }

  function handleComposerActivity(state: 'start' | 'stop') {
    if (!selectedId) return;
    realtimeRef.current?.sendTyping(selectedId, state);
  }

  async function loadStarred() {
    if (!accessToken) return;
    const { starred } = await api.listStarred(accessToken);
    const items = await Promise.all(
      starred.map(async (s) => ({
        ...(await decryptWire(s.message, s.message.senderId === user?.id)),
        conversationId: s.message.conversationId,
        starred: true,
      })),
    );
    setStarredItems(items);
    setShowStarred(true);
  }

  async function openMembersPanel() {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    const { members } = await api.listMembers(conversation.id, accessToken);
    setMembersPanelData(members);
    setShowMembers(true);
  }

  async function handleAddMember(username: string) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    try {
      const { member } = await api.addMember(conversation.id, username, accessToken);
      setMembersPanelData((prev) => [...prev, member]);
      setConversations((prev) =>
        prev.map((c) => (c.id === conversation.id ? { ...c, members: [...c.members, member] } : c)),
      );
      // Nothing to distribute: the new member is simply included in the recipient list
      // of every message sent from now on, and cannot read anything sent before.
    } catch {
      // Minimal handling for this pass: the add silently no-ops on failure (e.g.
      // user not found, already a member) rather than surfacing a toast.
    }
  }

  async function handleRemoveMember(userId: string) {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;

    await api.removeMember(conversation.id, userId, accessToken).catch(() => undefined);
    setMembersPanelData((prev) => prev.filter((m) => m.id !== userId));
    setConversations((prev) =>
      prev.map((c) => (c.id === conversation.id ? { ...c, members: c.members.filter((m) => m.id !== userId) } : c)),
    );
    // No key rotation is needed to lock the removed member out: recipients are computed
    // per message from the current member list, so nothing sent from here on is
    // addressed to them.
  }

  async function handleChangeRole(userId: string, role: 'ADMIN' | 'MEMBER') {
    const conversation = conversations.find((c) => c.id === selectedId);
    if (!conversation || !accessToken) return;
    await api.changeMemberRole(conversation.id, userId, role, accessToken).catch(() => undefined);
    setMembersPanelData((prev) => prev.map((m) => (m.id === userId ? { ...m, role } : m)));
  }

  if (!user) return null;

  const selectedConversation = conversations.find((c) => c.id === selectedId) ?? null;
  const forwardTargets = conversations
    .filter((c) => c.id !== selectedId)
    .map((c) => ({ id: c.id, label: c.type === 'DIRECT' ? (c.members[0]?.displayName ?? 'Conversation') : (c.title ?? 'Group') }));

  return (
    <div className="flex h-screen">
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={openConversation}
        onStartChat={handleStartChat}
        startChatError={startChatError}
        startingChatBusy={startingChatBusy}
        onCreateGroup={handleCreateGroup}
        loading={conversationsLoading}
      />
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-on-canvas px-6 py-3">
          <span className="text-sm text-ink-canvas-muted">Signed in as {user.displayName}</span>
          <div className="flex items-center gap-4">
            <button onClick={loadStarred} className="text-xs text-lavender hover:underline">
              ★ Starred
            </button>
            <button onClick={() => setShowBlocked(true)} className="text-xs text-lavender hover:underline">
              Blocked
            </button>
            <button onClick={() => logout().then(() => router.replace('/'))} className="text-xs text-lavender hover:underline">
              Log out
            </button>
          </div>
        </div>

        {selectedConversation && selectedConversation.type !== 'DIRECT' && (
          <>
            {workspace ? (
              <WorkspaceTabs active={activeTab} onChange={setActiveTab} />
            ) : (
              <div className="flex items-center justify-between border-b border-on-canvas bg-canvas-alt px-6 py-2">
                <span className="text-xs text-ink-canvas-muted">
                  Turn this chat into a workspace to add tasks, a shared calendar, and files.
                </span>
                <button
                  onClick={() => setShowCreateWorkspace(true)}
                  className="shrink-0 rounded-pill bg-coral px-3 py-1 text-xs font-medium text-cream"
                >
                  Create Workspace
                </button>
              </div>
            )}
          </>
        )}

        {activeTab === 'chat' || !workspace ? (
          <MessageThread
            conversation={selectedConversation}
            messages={selectedId ? (messagesByConversation[selectedId] ?? []) : []}
            peerTyping={selectedId ? Boolean(typingByConversation[selectedId]) : false}
            accessToken={accessToken ?? ''}
            myUserId={user.id}
            pinnedMessageId={selectedId ? (pinnedByConversation[selectedId] ?? null) : null}
            forwardTargets={forwardTargets}
            replyTarget={replyTarget}
            isPeerBlocked={Boolean(
              selectedConversation?.type === 'DIRECT' && blockedUserIds.includes(selectedConversation.members[0]?.id ?? ''),
            )}
            onSend={handleSend}
            onSendFile={handleSendFile}
            onSendVoice={handleSendVoice}
            onSendSticker={handleSendSticker}
            onSendGif={handleSendGif}
            onScheduleSend={handleScheduleSend}
            onSetDisappearing={handleSetDisappearing}
            onToggleBlock={handleToggleBlock}
            onReport={handleReport}
            onSearchGifs={handleSearchGifs}
            onComposerActivity={handleComposerActivity}
            onSetReplyTarget={setReplyTarget}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onReact={handleReact}
            onToggleStar={handleToggleStar}
            onTogglePin={handleTogglePin}
            onForward={handleForward}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onOpenMembers={openMembersPanel}
            hasMoreHistory={selectedId ? (hasMoreByConversation[selectedId] ?? true) : false}
            onLoadOlder={() => selectedId && loadOlderMessages(selectedId)}
            onCreateTaskFromMessage={
              selectedConversation && selectedConversation.type !== 'DIRECT' ? handleCreateTaskFromMessage : undefined
            }
            onCreateEventFromMessage={
              selectedConversation && selectedConversation.type !== 'DIRECT' ? handleCreateEventFromMessage : undefined
            }
            onCreatePollFromMessage={
              selectedConversation && selectedConversation.type !== 'DIRECT' ? handleCreatePollFromMessage : undefined
            }
          />
        ) : activeTab === 'dashboard' ? (
          <WorkspaceDashboard data={dashboard} loading={dashboardLoading} e2ee={e2ee} onSwitchTab={setActiveTab} />
        ) : activeTab === 'tasks' ? (
          <TaskBoard
            tasks={tasks}
            loading={tasksLoading}
            e2ee={e2ee}
            memberById={(id) =>
              id === user.id ? { displayName: user.displayName } : selectedConversation?.members.find((m) => m.id === id)
            }
            onOpenTask={handleOpenTask}
            onToggleDone={handleToggleTaskDone}
            onCreateNew={() => setShowCreateTask(true)}
          />
        ) : activeTab === 'schedule' ? (
          <CalendarView
            events={events}
            loading={eventsLoading}
            e2ee={e2ee}
            myUserId={user.id}
            onOpenEvent={() => undefined}
            onRsvp={handleRsvp}
            onCreateNew={() => setShowCreateEvent(true)}
          />
        ) : activeTab === 'notes' ? (
          <NotesTab notes={notes} loading={notesLoading} e2ee={e2ee} onCreate={handleCreateNote} onUpdate={handleUpdateNote} onDelete={handleDeleteNote} />
        ) : activeTab === 'decisions' ? (
          <DecisionsTab
            decisions={decisions}
            loading={decisionsLoading}
            e2ee={e2ee}
            memberById={(id) =>
              id === user.id ? { displayName: user.displayName } : selectedConversation?.members.find((m) => m.id === id)
            }
            onCreate={handleCreateDecision}
            onDelete={handleDeleteDecision}
          />
        ) : activeTab === 'polls' ? (
          <PollsTab polls={polls} loading={pollsLoading} e2ee={e2ee} myUserId={user.id} onCreate={handleCreatePoll} onVote={handleVotePoll} onDelete={handleDeletePoll} />
        ) : activeTab === 'files' ? (
          <FilesTab
            files={files}
            loading={filesLoading}
            storage={storageSummary}
            folders={folders}
            category={fileCategory}
            onSelectCategory={setFileCategory}
            memberById={(id) =>
              id === user.id ? { displayName: user.displayName } : selectedConversation?.members.find((m) => m.id === id)
            }
            accessToken={accessToken ?? ''}
            e2ee={e2ee}
            decryptFile={decryptFileEnvelope}
            onAssignFolder={handleAssignFileFolder}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            onDeleteFile={handleDeleteFile}
            onJumpToMessage={() => setActiveTab('chat')}
          />
        ) : (
          <ComingSoonTab tab={activeTab} />
        )}
      </div>

      {showCreateWorkspace && selectedConversation && (
        <CreateWorkspaceModal
          defaultName={selectedConversation.title ?? 'New Workspace'}
          onCreate={handleCreateWorkspace}
          onClose={() => setShowCreateWorkspace(false)}
        />
      )}

      {showCreateTask && selectedConversation && (
        <CreateTaskModal members={selectedConversation.members} onCreate={handleCreateTask} onClose={() => setShowCreateTask(false)} />
      )}

      {showCreateEvent && (
        <CreateEventModal
          defaultTitle={pendingEventTitle}
          onCreate={handleCreateEvent}
          onClose={() => {
            setShowCreateEvent(false);
            setPendingEventTitle('');
          }}
        />
      )}

      {selectedTaskId &&
        (() => {
          const task = tasks.find((t) => t.id === selectedTaskId);
          if (!task || !workspace || !selectedConversation) return null;
          return (
            <TaskDetailPanel
              task={task}
              workspaceName={workspace.name}
              members={selectedConversation.members}
              e2ee={e2ee}
              activity={taskActivity}
              onClose={() => setSelectedTaskId(null)}
              onToggleDone={() => handleToggleTaskDone(task)}
              onChangeStatus={(status) => patchTask(task.id, { status })}
              onChangePriority={(priority) => patchTask(task.id, { priority })}
              onChangeAssignee={(assigneeId) => patchTask(task.id, { assigneeId })}
              onChangeDueDate={(dueDate) => patchTask(task.id, { dueDate })}
              onAddSubtask={(title) => handleAddSubtask(task.id, title)}
              onToggleSubtask={(subtaskId, done) => handleToggleSubtask(task.id, subtaskId, done)}
              onDeleteSubtask={(subtaskId) => handleDeleteSubtask(task.id, subtaskId)}
              onAddComment={(text) => handleAddTaskComment(task.id, text)}
              onDelete={() => handleDeleteTask(task.id)}
            />
          );
        })()}

      {celebrationTask && workspace && (
        <TaskCelebration
          task={celebrationTask}
          workspaceName={workspace.name}
          e2ee={e2ee}
          onViewTask={() => {
            setSelectedTaskId(celebrationTask.id);
            handleOpenTask(celebrationTask.id);
            setCelebrationTask(null);
          }}
          onCreateAnother={() => {
            setCelebrationTask(null);
            setShowCreateTask(true);
          }}
          onClose={() => setCelebrationTask(null)}
        />
      )}

      {showStarred && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setShowStarred(false)}>
          <div
            className="max-h-[70vh] w-full max-w-md overflow-y-auto rounded-lg bg-card p-6 shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg text-ink-card">Starred messages</h3>
            {starredItems.length === 0 && <p className="mt-4 text-sm text-ink-card-muted">Nothing starred yet.</p>}
            <ul className="mt-3 space-y-2">
              {starredItems.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => {
                      setShowStarred(false);
                      openConversation(item.conversationId);
                    }}
                    className="block w-full rounded-sm bg-card-alt px-3 py-2 text-left text-sm text-ink-card hover:opacity-80"
                  >
                    {item.media ? `\uD83D\uDCCE ${item.text}` : item.text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {showMembers && selectedConversation && (
        <MembersPanel
          title={selectedConversation.title ?? 'Group'}
          members={membersPanelData}
          myUserId={user.id}
          myRole={selectedConversation.myRole}
          onAddMember={handleAddMember}
          onRemoveMember={handleRemoveMember}
          onChangeRole={handleChangeRole}
          onClose={() => setShowMembers(false)}
        />
      )}
    </div>
  );
}
