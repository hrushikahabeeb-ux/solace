/**
 * Thin fetch wrapper for the Fastify API. Every call goes through here so the
 * Authorization header and credentials:'include' (needed for the refresh cookie)
 * are never forgotten on a one-off call site.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface DeviceKeyPayload {
  label: string;
  /** ECDH P-256 identity public key, base64 (see @solace/crypto identity.ts). */
  identityKeyPublic: string;
}

export interface AuthResponse {
  user: { id: string; username: string; displayName: string };
  deviceId: string;
  accessToken: string;
}

export interface DirectoryDevice {
  userId: string;
  deviceId: string;
  identityKeyPublic: string;
}

export interface ConversationMemberSummary {
  id: string;
  username: string;
  displayName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  /** @deprecated Encryption no longer targets a single "primary" device; every active
   *  device of every member is addressed (see lib/e2ee.ts). Kept only because the API
   *  still returns it. */
  primaryDeviceId: string | null;
}

export interface ConversationSummary {
  id: string;
  type: 'DIRECT' | 'GROUP' | 'CHANNEL';
  title: string | null;
  myRole?: 'OWNER' | 'ADMIN' | 'MEMBER';
  disappearingSeconds?: number | null;
  members: ConversationMemberSummary[];
  lastMessage: { id: string; senderId: string; createdAt: string } | null;
}

export interface Workspace {
  id: string;
  conversationId: string;
  name: string;
  emoji: string | null;
  description: string | null;
  createdAt: string;
}

export interface WorkspaceDashboard {
  workspace: Workspace;
  memberCount: number;
  taskCounts: { TODO: number; IN_PROGRESS: number; DONE: number };
  fileCount: number;
  upcomingEvents: WireEvent[];
  recentTasks: WireTask[];
}

export interface WireTask {
  id: string;
  workspaceId: string;
  titleCiphertext: string;
  descriptionCiphertext: string | null;
  sessionRef: string;
  status: 'TODO' | 'IN_PROGRESS' | 'DONE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  dueDate: string | null;
  labels: string[];
  assigneeId: string | null;
  createdById: string;
  sourceMessageId: string | null;
  mongoThreadId: string;
  createdAt: string;
  completedAt: string | null;
}

export interface Subtask {
  id: string;
  taskId: string;
  titleCiphertext: string;
  sessionRef: string;
  done: boolean;
  createdAt: string;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  messageId: string;
}

export interface WireTaskWithDetails extends WireTask {
  subtasks: Subtask[];
  attachments: TaskAttachment[];
}

export interface TaskActivityEntry {
  _id: string;
  taskId: string;
  workspaceId: string;
  type: 'activity' | 'comment';
  authorId: string;
  createdAt: string;
  activity?: { kind: string; from?: string | null; to?: string | null };
  ciphertext?: string;
  sessionRef?: string;
}

export interface EventParticipant {
  id: string;
  eventId: string;
  userId: string;
  rsvp: 'GOING' | 'MAYBE' | 'DECLINED' | 'PENDING';
  respondedAt: string | null;
}

export interface WireEventWithParticipants extends WireEvent {
  participants: EventParticipant[];
}

export interface Note {
  _id: string;
  workspaceId: string;
  titleCiphertext: string;
  bodyCiphertext: string;
  sessionRef: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  _id: string;
  workspaceId: string;
  titleCiphertext: string;
  descriptionCiphertext?: string;
  sessionRef: string;
  sourceMessageId?: string;
  decidedById: string;
  createdAt: string;
}

export interface PollOption {
  id: string;
  textCiphertext: string;
}

export interface PollVote {
  userId: string;
  optionId: string;
  votedAt: string;
}

export interface Poll {
  _id: string;
  workspaceId: string;
  questionCiphertext: string;
  sessionRef: string;
  options: PollOption[];
  votes: PollVote[];
  sourceMessageId?: string;
  createdById: string;
  createdAt: string;
}

export type FileCategory = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';

export interface WorkspaceFile {
  messageId: string;
  senderId: string;
  sizeBytes: number;
  mimeTypeGuess: string | null;
  category: FileCategory;
  folderId: string | null;
  createdAt: string;
  ciphertext: string;
  olmMessageType: number;
  sessionRef: string;
}

export interface StorageSummary {
  totalBytes: number;
  byCategory: Record<FileCategory, number>;
  fileCount: number;
}

export interface Folder {
  id: string;
  workspaceId: string;
  nameCiphertext: string;
  sessionRef: string;
  parentId: string | null;
  createdAt: string;
}

export interface WireEvent {
  id: string;
  workspaceId: string;
  titleCiphertext: string;
  descriptionCiphertext: string | null;
  locationCiphertext: string | null;
  onlineLinkCiphertext: string | null;
  sessionRef: string;
  startAt: string;
  endAt: string | null;
  timezone: string;
  recurrenceRule: string | null;
  sourceMessageId: string | null;
  createdById: string;
  createdAt: string;
}

export interface WireMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: 'TEXT' | 'MEDIA' | 'SYSTEM';
  ciphertext: string;
  olmMessageType: number;
  sessionRef: string;
  replyToId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  media?: { sizeBytes: number; contentHash: string; mimeTypeGuess: string | null } | null;
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string | null;
  image: string | null;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

/**
 * Access tokens live for 15 minutes. Call sites capture the token that was current when
 * they started, so a long-lived tab or a slow request can easily hold an expired one.
 * AuthProvider registers a handler that trades the refresh cookie for a new token; any
 * request that comes back 401 is retried exactly once with it. Concurrent 401s share one
 * refresh call.
 */
type TokenRefresher = () => Promise<string | null>;
let tokenRefresher: TokenRefresher | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export function setTokenRefresher(refresher: TokenRefresher | null): void {
  tokenRefresher = refresher;
}

function refreshOnce(): Promise<string | null> {
  if (!tokenRefresher) return Promise.resolve(null);
  if (!refreshInFlight) {
    refreshInFlight = tokenRefresher()
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function request<T>(path: string, init: RequestInit, accessToken?: string, isRetry = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) headers['Content-Type'] = 'application/json';
  if (init.headers) Object.assign(headers, init.headers);
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include', headers });
  if (res.status === 401 && accessToken && !isRetry) {
    const fresh = await refreshOnce();
    if (fresh) return request<T>(path, init, fresh, true);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'unknown_error' }));
    throw new ApiError(res.status, body.error ?? 'unknown_error');
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  register(input: { username: string; displayName: string; password: string; device: DeviceKeyPayload }) {
    return request<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify(input) });
  },
  login(input: { username: string; password: string; device?: DeviceKeyPayload; existingDeviceId?: string }) {
    return request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(input) });
  },
  refresh() {
    return request<{ accessToken: string }>('/auth/refresh', { method: 'POST' });
  },
  logout() {
    return request<void>('/auth/logout', { method: 'POST' });
  },
  me(accessToken: string) {
    return request<{ user: AuthResponse['user']; deviceId: string }>('/auth/me', { method: 'GET' }, accessToken);
  },

  lookupUser(username: string, accessToken: string) {
    return request<{ id: string; username: string; displayName: string; primaryDeviceId: string | null }>(
      `/users/lookup?username=${encodeURIComponent(username)}`,
      { method: 'GET' },
      accessToken,
    );
  },
  createDirectConversation(peerUsername: string, accessToken: string) {
    return request<{ id: string; type: 'DIRECT'; peer: ConversationMemberSummary }>(
      '/conversations/direct',
      { method: 'POST', body: JSON.stringify({ peerUsername }) },
      accessToken,
    );
  },
  listConversations(accessToken: string) {
    return request<{ conversations: ConversationSummary[] }>('/conversations', { method: 'GET' }, accessToken);
  },
  listMessages(conversationId: string, accessToken: string, before?: string) {
    const qs = before ? `?before=${encodeURIComponent(before)}` : '';
    return request<{ messages: WireMessage[] }>(`/conversations/${conversationId}/messages${qs}`, { method: 'GET' }, accessToken);
  },
  sendMessage(
    conversationId: string,
    payload: {
      type: 'TEXT' | 'MEDIA';
      ciphertext: string;
      olmMessageType: number;
      sessionRef: string;
      replyToId?: string;
      media?: { storageKey: string; sizeBytes: number; contentHash: string; mimeTypeGuess?: string };
    },
    accessToken: string,
  ) {
    return request<{ message: WireMessage }>(
      `/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify(payload) },
      accessToken,
    );
  },
  sendReceipt(conversationId: string, messageId: string, status: 'DELIVERED' | 'READ', accessToken: string) {
    return request<void>(
      `/conversations/${conversationId}/messages/${messageId}/receipt`,
      { method: 'POST', body: JSON.stringify({ status }) },
      accessToken,
    );
  },
  /** Device directory: the active devices of `userIds`, and/or specific devices by id. */
  lookupDevices(query: { userIds?: string[]; deviceIds?: string[] }, accessToken: string) {
    return request<{ devices: DirectoryDevice[] }>(
      '/keys/lookup',
      { method: 'POST', body: JSON.stringify(query) },
      accessToken,
    );
  },

  editMessage(messageId: string, payload: { ciphertext: string; olmMessageType: number }, accessToken: string) {
    return request<{ message: WireMessage }>(`/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify(payload) }, accessToken);
  },
  deleteMessage(messageId: string, accessToken: string) {
    return request<void>(`/messages/${messageId}`, { method: 'DELETE' }, accessToken);
  },
  toggleReaction(messageId: string, emoji: string, accessToken: string) {
    return request<{ action: 'added' | 'removed' }>(
      `/messages/${messageId}/reactions`,
      { method: 'POST', body: JSON.stringify({ emoji }) },
      accessToken,
    );
  },
  pinMessage(messageId: string, accessToken: string) {
    return request<void>(`/messages/${messageId}/pin`, { method: 'POST' }, accessToken);
  },
  unpinMessage(messageId: string, accessToken: string) {
    return request<void>(`/messages/${messageId}/pin`, { method: 'DELETE' }, accessToken);
  },
  listPins(conversationId: string, accessToken: string) {
    return request<{ pins: { messageId: string; message: WireMessage }[] }>(
      `/conversations/${conversationId}/pins`,
      { method: 'GET' },
      accessToken,
    );
  },
  starMessage(messageId: string, accessToken: string) {
    return request<void>(`/messages/${messageId}/star`, { method: 'POST' }, accessToken);
  },
  unstarMessage(messageId: string, accessToken: string) {
    return request<void>(`/messages/${messageId}/star`, { method: 'DELETE' }, accessToken);
  },
  listStarred(accessToken: string) {
    return request<{ starred: { messageId: string; message: WireMessage }[] }>('/me/starred', { method: 'GET' }, accessToken);
  },
  linkPreview(url: string, accessToken: string) {
    return request<LinkPreview>(`/link-preview?url=${encodeURIComponent(url)}`, { method: 'GET' }, accessToken);
  },

  /** STUN/TURN configuration for a call, with short-lived TURN credentials. */
  getIceServers(accessToken: string) {
    return request<{ iceServers: RTCIceServer[]; relayAvailable: boolean; ttlSeconds: number }>(
      '/calls/ice-servers',
      { method: 'GET' },
      accessToken,
    );
  },

  getUploadUrl(sizeBytes: number, accessToken: string) {
    return request<{ storageKey: string; uploadUrl: string; expiresInSeconds: number }>(
      '/media/upload-url',
      { method: 'POST', body: JSON.stringify({ sizeBytes }) },
      accessToken,
    );
  },
  getDownloadUrl(messageId: string, accessToken: string) {
    return request<{ downloadUrl: string; sizeBytes: number; contentHash: string }>(
      `/media/${messageId}/download-url`,
      { method: 'GET' },
      accessToken,
    );
  },

  createGroup(title: string, memberUsernames: string[], accessToken: string) {
    return request<{ id: string; type: 'GROUP'; title: string; members: ConversationMemberSummary[] }>(
      '/conversations/group',
      { method: 'POST', body: JSON.stringify({ title, memberUsernames }) },
      accessToken,
    );
  },
  listMembers(conversationId: string, accessToken: string) {
    return request<{ members: ConversationMemberSummary[] }>(`/conversations/${conversationId}/members`, { method: 'GET' }, accessToken);
  },
  addMember(conversationId: string, username: string, accessToken: string) {
    return request<{ member: ConversationMemberSummary }>(
      `/conversations/${conversationId}/members`,
      { method: 'POST', body: JSON.stringify({ username }) },
      accessToken,
    );
  },
  removeMember(conversationId: string, userId: string, accessToken: string) {
    return request<void>(`/conversations/${conversationId}/members/${userId}`, { method: 'DELETE' }, accessToken);
  },
  changeMemberRole(conversationId: string, userId: string, role: 'ADMIN' | 'MEMBER', accessToken: string) {
    return request<{ role: string }>(
      `/conversations/${conversationId}/members/${userId}`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
      accessToken,
    );
  },

  scheduleMessage(
    conversationId: string,
    payload: {
      type: 'TEXT' | 'MEDIA';
      ciphertext: string;
      olmMessageType: number;
      sessionRef: string;
      replyToId?: string;
      scheduledFor: string;
    },
    accessToken: string,
  ) {
    return request<{ message: WireMessage }>(
      `/conversations/${conversationId}/messages/schedule`,
      { method: 'POST', body: JSON.stringify(payload) },
      accessToken,
    );
  },
  setDisappearing(conversationId: string, seconds: number | null, accessToken: string) {
    return request<void>(
      `/conversations/${conversationId}/disappearing`,
      { method: 'PATCH', body: JSON.stringify({ seconds }) },
      accessToken,
    );
  },

  blockUser(userId: string, accessToken: string) {
    return request<void>(`/users/${userId}/block`, { method: 'POST' }, accessToken);
  },
  unblockUser(userId: string, accessToken: string) {
    return request<void>(`/users/${userId}/block`, { method: 'DELETE' }, accessToken);
  },
  listBlocked(accessToken: string) {
    return request<{ blocked: { id: string; username: string; displayName: string }[] }>('/me/blocked', { method: 'GET' }, accessToken);
  },
  reportMessage(messageId: string, reason: string, accessToken: string) {
    return request<void>(`/messages/${messageId}/report`, { method: 'POST', body: JSON.stringify({ reason }) }, accessToken);
  },

  searchGifs(query: string, accessToken: string) {
    return request<{ results: { id: string; previewUrl: string; url: string }[] }>(
      `/gifs/search?q=${encodeURIComponent(query)}`,
      { method: 'GET' },
      accessToken,
    );
  },

  createWorkspace(
    conversationId: string,
    input: { name: string; emoji?: string; description?: string },
    accessToken: string,
  ) {
    return request<{ workspace: Workspace }>(
      `/conversations/${conversationId}/workspace`,
      { method: 'POST', body: JSON.stringify(input) },
      accessToken,
    );
  },
  getWorkspaceForConversation(conversationId: string, accessToken: string) {
    return request<{ workspace: Workspace | null }>(`/conversations/${conversationId}/workspace`, { method: 'GET' }, accessToken);
  },
  getWorkspaceDashboard(workspaceId: string, accessToken: string) {
    return request<WorkspaceDashboard>(`/workspaces/${workspaceId}/dashboard`, { method: 'GET' }, accessToken);
  },
  updateWorkspace(workspaceId: string, patch: { name?: string; emoji?: string; description?: string }, accessToken: string) {
    return request<{ workspace: Workspace }>(
      `/workspaces/${workspaceId}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      accessToken,
    );
  },

  createTask(
    workspaceId: string,
    input: {
      titleCiphertext: string;
      descriptionCiphertext?: string;
      sessionRef: string;
      priority?: 'LOW' | 'MEDIUM' | 'HIGH';
      dueDate?: string;
      labels?: string[];
      assigneeId?: string;
      sourceMessageId?: string;
    },
    accessToken: string,
  ) {
    return request<{ task: WireTaskWithDetails }>(
      `/workspaces/${workspaceId}/tasks`,
      { method: 'POST', body: JSON.stringify(input) },
      accessToken,
    );
  },
  listTasks(workspaceId: string, accessToken: string, status?: 'TODO' | 'IN_PROGRESS' | 'DONE') {
    const qs = status ? `?status=${status}` : '';
    return request<{ tasks: WireTaskWithDetails[] }>(`/workspaces/${workspaceId}/tasks${qs}`, { method: 'GET' }, accessToken);
  },
  getTask(taskId: string, accessToken: string) {
    return request<{ task: WireTaskWithDetails }>(`/tasks/${taskId}`, { method: 'GET' }, accessToken);
  },
  updateTask(
    taskId: string,
    patch: Partial<{
      titleCiphertext: string;
      descriptionCiphertext: string | null;
      sessionRef: string;
      status: 'TODO' | 'IN_PROGRESS' | 'DONE';
      priority: 'LOW' | 'MEDIUM' | 'HIGH';
      dueDate: string | null;
      labels: string[];
      assigneeId: string | null;
    }>,
    accessToken: string,
  ) {
    return request<{ task: WireTaskWithDetails }>(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(patch) }, accessToken);
  },
  deleteTask(taskId: string, accessToken: string) {
    return request<void>(`/tasks/${taskId}`, { method: 'DELETE' }, accessToken);
  },

  createSubtask(taskId: string, input: { titleCiphertext: string; sessionRef: string }, accessToken: string) {
    return request<{ subtask: Subtask }>(`/tasks/${taskId}/subtasks`, { method: 'POST', body: JSON.stringify(input) }, accessToken);
  },
  toggleSubtask(subtaskId: string, done: boolean, accessToken: string) {
    return request<{ subtask: Subtask }>(`/subtasks/${subtaskId}`, { method: 'PATCH', body: JSON.stringify({ done }) }, accessToken);
  },
  deleteSubtask(subtaskId: string, accessToken: string) {
    return request<void>(`/subtasks/${subtaskId}`, { method: 'DELETE' }, accessToken);
  },

  addTaskAttachment(taskId: string, messageId: string, accessToken: string) {
    return request<{ attachment: TaskAttachment }>(
      `/tasks/${taskId}/attachments`,
      { method: 'POST', body: JSON.stringify({ messageId }) },
      accessToken,
    );
  },

  listTaskActivity(taskId: string, accessToken: string) {
    return request<{ entries: TaskActivityEntry[] }>(`/tasks/${taskId}/activity`, { method: 'GET' }, accessToken);
  },
  addTaskComment(taskId: string, input: { ciphertext: string; sessionRef: string }, accessToken: string) {
    return request<{ entry: TaskActivityEntry }>(
      `/tasks/${taskId}/comments`,
      { method: 'POST', body: JSON.stringify(input) },
      accessToken,
    );
  },

  createEvent(
    workspaceId: string,
    input: {
      titleCiphertext: string;
      descriptionCiphertext?: string;
      locationCiphertext?: string;
      onlineLinkCiphertext?: string;
      sessionRef: string;
      startAt: string;
      endAt?: string;
      timezone: string;
      recurrenceRule?: string;
      sourceMessageId?: string;
    },
    accessToken: string,
  ) {
    return request<{ event: WireEventWithParticipants }>(
      `/workspaces/${workspaceId}/events`,
      { method: 'POST', body: JSON.stringify(input) },
      accessToken,
    );
  },
  listEvents(workspaceId: string, accessToken: string, range?: { from?: string; to?: string }) {
    const qs = new URLSearchParams();
    if (range?.from) qs.set('from', range.from);
    if (range?.to) qs.set('to', range.to);
    const query = qs.toString();
    return request<{ events: WireEventWithParticipants[] }>(
      `/workspaces/${workspaceId}/events${query ? `?${query}` : ''}`,
      { method: 'GET' },
      accessToken,
    );
  },
  getEvent(eventId: string, accessToken: string) {
    return request<{ event: WireEventWithParticipants }>(`/events/${eventId}`, { method: 'GET' }, accessToken);
  },
  updateEvent(
    eventId: string,
    patch: Partial<{
      titleCiphertext: string;
      descriptionCiphertext: string | null;
      locationCiphertext: string | null;
      onlineLinkCiphertext: string | null;
      sessionRef: string;
      startAt: string;
      endAt: string | null;
      timezone: string;
      recurrenceRule: string | null;
    }>,
    accessToken: string,
  ) {
    return request<{ event: WireEventWithParticipants }>(`/events/${eventId}`, { method: 'PATCH', body: JSON.stringify(patch) }, accessToken);
  },
  deleteEvent(eventId: string, accessToken: string) {
    return request<void>(`/events/${eventId}`, { method: 'DELETE' }, accessToken);
  },
  rsvpToEvent(eventId: string, status: 'GOING' | 'MAYBE' | 'DECLINED', accessToken: string) {
    return request<{ participant: EventParticipant }>(
      `/events/${eventId}/rsvp`,
      { method: 'POST', body: JSON.stringify({ status }) },
      accessToken,
    );
  },

  createNote(workspaceId: string, input: { titleCiphertext: string; bodyCiphertext: string; sessionRef: string }, accessToken: string) {
    return request<{ note: Note }>(`/workspaces/${workspaceId}/notes`, { method: 'POST', body: JSON.stringify(input) }, accessToken);
  },
  listNotes(workspaceId: string, accessToken: string) {
    return request<{ notes: Note[] }>(`/workspaces/${workspaceId}/notes`, { method: 'GET' }, accessToken);
  },
  updateNote(noteId: string, input: { titleCiphertext: string; bodyCiphertext: string; sessionRef: string }, accessToken: string) {
    return request<{ note: Note }>(`/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(input) }, accessToken);
  },
  deleteNote(noteId: string, accessToken: string) {
    return request<void>(`/notes/${noteId}`, { method: 'DELETE' }, accessToken);
  },

  createDecision(
    workspaceId: string,
    input: { titleCiphertext: string; descriptionCiphertext?: string; sessionRef: string; sourceMessageId?: string },
    accessToken: string,
  ) {
    return request<{ decision: Decision }>(`/workspaces/${workspaceId}/decisions`, { method: 'POST', body: JSON.stringify(input) }, accessToken);
  },
  listDecisions(workspaceId: string, accessToken: string) {
    return request<{ decisions: Decision[] }>(`/workspaces/${workspaceId}/decisions`, { method: 'GET' }, accessToken);
  },
  deleteDecision(decisionId: string, accessToken: string) {
    return request<void>(`/decisions/${decisionId}`, { method: 'DELETE' }, accessToken);
  },

  createPoll(
    workspaceId: string,
    input: { questionCiphertext: string; sessionRef: string; options: { textCiphertext: string }[]; sourceMessageId?: string },
    accessToken: string,
  ) {
    return request<{ poll: Poll }>(`/workspaces/${workspaceId}/polls`, { method: 'POST', body: JSON.stringify(input) }, accessToken);
  },
  listPolls(workspaceId: string, accessToken: string) {
    return request<{ polls: Poll[] }>(`/workspaces/${workspaceId}/polls`, { method: 'GET' }, accessToken);
  },
  voteOnPoll(pollId: string, optionId: string, accessToken: string) {
    return request<{ poll: Poll }>(`/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ optionId }) }, accessToken);
  },
  deletePoll(pollId: string, accessToken: string) {
    return request<void>(`/polls/${pollId}`, { method: 'DELETE' }, accessToken);
  },

  listFiles(
    workspaceId: string,
    accessToken: string,
    filter?: { category?: FileCategory; senderId?: string; folderId?: string; unfiled?: boolean },
  ) {
    const qs = new URLSearchParams();
    if (filter?.category) qs.set('category', filter.category);
    if (filter?.senderId) qs.set('senderId', filter.senderId);
    if (filter?.folderId) qs.set('folderId', filter.folderId);
    if (filter?.unfiled) qs.set('unfiled', 'true');
    const query = qs.toString();
    return request<{ files: WorkspaceFile[] }>(`/workspaces/${workspaceId}/files${query ? `?${query}` : ''}`, { method: 'GET' }, accessToken);
  },
  getStorageSummary(workspaceId: string, accessToken: string) {
    return request<StorageSummary>(`/workspaces/${workspaceId}/storage`, { method: 'GET' }, accessToken);
  },
  assignFileToFolder(messageId: string, folderId: string | null, accessToken: string) {
    return request<void>(`/media/${messageId}/folder`, { method: 'PATCH', body: JSON.stringify({ folderId }) }, accessToken);
  },

  createFolder(workspaceId: string, input: { nameCiphertext: string; sessionRef: string; parentId?: string }, accessToken: string) {
    return request<{ folder: Folder }>(`/workspaces/${workspaceId}/folders`, { method: 'POST', body: JSON.stringify(input) }, accessToken);
  },
  listFolders(workspaceId: string, accessToken: string) {
    return request<{ folders: Folder[] }>(`/workspaces/${workspaceId}/folders`, { method: 'GET' }, accessToken);
  },
  renameFolder(folderId: string, input: { nameCiphertext: string; sessionRef: string }, accessToken: string) {
    return request<{ folder: Folder }>(`/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify(input) }, accessToken);
  },
  deleteFolder(folderId: string, accessToken: string) {
    return request<void>(`/folders/${folderId}`, { method: 'DELETE' }, accessToken);
  },
};

export { ApiError };
