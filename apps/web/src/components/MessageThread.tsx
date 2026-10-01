'use client';

import { useEffect, useRef, useState, memo, type FormEvent } from 'react';
import type { ConversationSummary } from '../lib/api';
import { tokenizeMessageText, firstUrlIn } from '../lib/textParsing';
import { LinkPreviewCard } from './LinkPreviewCard';
import { MediaBubble, type MediaPayload } from './MediaBubble';
import { isImageFile } from '../lib/mediaPipeline';
import { VoiceRecorder, describeRecorderError, formatClock } from '../lib/voiceRecorder';
import { StickerGifPicker, type GifResult } from './StickerGifPicker';
import { saveDraft, loadDraft } from '../lib/draftStore';
import { useCall } from './CallProvider';
import { PhoneIcon, VideoIcon } from './callIcons';
import type { CallLogInfo } from '../lib/callLog';

export interface DisplayMessage {
  id: string;
  senderId: string;
  mine: boolean;
  text: string;
  media?: MediaPayload;
  sticker?: { emoji: string };
  gif?: { url: string; previewUrl: string };
  call?: CallLogInfo;
  createdAt: string;
  status: 'sent' | 'delivered' | 'read' | null;
  editedAt: string | null;
  deletedAt: string | null;
  replyToId: string | null;
  reactions: Record<string, string[]>;
  starred: boolean;
}

const QUICK_EMOJI = ['\u2764\uFE0F', '\uD83D\uDE02', '\uD83D\uDC4D', '\uD83D\uDE2E', '\uD83D\uDE22'];
const DISAPPEARING_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: 'Off', seconds: null },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '1 week', seconds: 604800 },
];

export function MessageThread({
  conversation,
  messages,
  peerTyping,
  accessToken,
  myUserId,
  pinnedMessageId,
  forwardTargets,
  replyTarget,
  isPeerBlocked,
  onSend,
  onComposerActivity,
  onSetReplyTarget,
  onEdit,
  onDelete,
  onReact,
  onToggleStar,
  onTogglePin,
  onForward,
  onReport,
  searchQuery,
  onSearchQueryChange,
  onSendFile,
  onSendVoice,
  onSendSticker,
  onSendGif,
  onScheduleSend,
  onSetDisappearing,
  onToggleBlock,
  onOpenMembers,
  onSearchGifs,
  hasMoreHistory,
  onLoadOlder,
  onCreateTaskFromMessage,
  onCreateEventFromMessage,
  onCreatePollFromMessage,
}: {
  conversation: ConversationSummary | null;
  messages: DisplayMessage[];
  peerTyping: boolean;
  accessToken: string;
  myUserId: string;
  pinnedMessageId: string | null;
  forwardTargets: { id: string; label: string }[];
  replyTarget: DisplayMessage | null;
  isPeerBlocked: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onComposerActivity: (state: 'start' | 'stop') => void;
  onSetReplyTarget: (message: DisplayMessage | null) => void;
  onEdit: (messageId: string, newText: string) => void;
  onDelete: (messageId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  onToggleStar: (messageId: string, currentlyStarred: boolean) => void;
  onTogglePin: (messageId: string, currentlyPinned: boolean) => void;
  onForward: (messageId: string, targetConversationId: string) => void;
  onReport: (messageId: string) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onSendFile: (file: File, sendOriginalQuality: boolean) => void;
  onSendVoice: (blob: Blob, durationSeconds: number) => void;
  onSendSticker: (emoji: string) => void;
  onSendGif: (gif: GifResult) => void;
  onScheduleSend: (text: string, isoDateTime: string, replyToId?: string) => void;
  onSetDisappearing: (seconds: number | null) => void;
  onToggleBlock: () => void;
  onOpenMembers: () => void;
  onSearchGifs: (query: string) => Promise<GifResult[]>;
  hasMoreHistory: boolean;
  onLoadOlder: () => void;
  onCreateTaskFromMessage?: (message: DisplayMessage) => void;
  onCreateEventFromMessage?: (message: DisplayMessage) => void;
  onCreatePollFromMessage?: (message: DisplayMessage) => void;
}) {
  const [draft, setDraft] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sendOriginalQuality, setSendOriginalQuality] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recorderNotice, setRecorderNotice] = useState<string | null>(null);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [showConvoMenu, setShowConvoMenu] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  // Guards against a second recorder being created while the permission prompt is open.
  const startingRef = useRef(false);
  // Bumped whenever a pending or running recording stops being valid (conversation switch,
  // unmount), so a permission prompt answered late cannot start recording into the wrong chat.
  const recordingTokenRef = useRef(0);
  const finishRecordingRef = useRef<(send: boolean) => Promise<void>>(async () => undefined);
  const call = useCall();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (!recording) {
      setRecordingSeconds(0);
      return;
    }
    const tick = () => {
      const recorder = recorderRef.current;
      if (recorder) setRecordingSeconds((Date.now() - recorder.startedAtMs) / 1000);
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [recording]);

  useEffect(() => {
    if (!recorderNotice) return;
    const timer = setTimeout(() => setRecorderNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [recorderNotice]);

  // A recording belongs to the conversation it was started in. Leaving that conversation
  // (or the page) discards it and, importantly, releases the microphone: without this the
  // browser's recording indicator would stay on with no way to stop it from the new chat.
  useEffect(() => {
    return () => {
      recordingTokenRef.current += 1;
      startingRef.current = false;
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecording(false);
      setRecorderNotice(null);
    };
  }, [conversation?.id]);

  useEffect(() => {
    setDraft(conversation ? loadDraft(conversation.id) : '');
  }, [conversation?.id]);

  useEffect(() => {
    if (conversation) saveDraft(conversation.id, draft);
  }, [draft, conversation?.id]);

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center bg-canvas">
        <p className="text-ink-canvas-muted">Select a conversation or start a new one.</p>
      </div>
    );
  }

  const peer = conversation.members[0];
  const isGroup = conversation.type !== 'DIRECT';
  const headerTitle = isGroup ? (conversation.title ?? 'Group') : (peer?.displayName ?? 'Unknown');
  const headerSubtitle = isGroup ? `${conversation.members.length + 1} members` : `@${peer?.username}`;

  // Calls are one-to-one only (the server refuses anything else), so groups get no call
  // controls. The reason a button is disabled is spelled out in its tooltip.
  const conversationId = conversation.id;
  const callDisabledReason = isPeerBlocked
    ? `Unblock ${peer?.displayName ?? 'this user'} to call`
    : !call.signalingReady
      ? 'Call service is unavailable right now'
      : call.state.phase !== 'idle'
        ? 'You are already in a call'
        : null;

  function placeCall(media: 'audio' | 'video') {
    if (!peer || callDisabledReason) return;
    void call.startCall({ conversationId, peer: { id: peer.id, displayName: peer.displayName }, media });
  }
  const visibleMessages = searchQuery.trim()
    ? messages.filter((m) => m.text.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : messages;
  const pinnedMessage = pinnedMessageId ? messages.find((m) => m.id === pinnedMessageId) : null;
  const findById = (id: string | null) => (id ? messages.find((m) => m.id === id) : undefined);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text, replyTarget?.id);
    setDraft('');
    onComposerActivity('stop');
    onSetReplyTarget(null);
  }

  function handleScheduleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !scheduleAt) return;
    onScheduleSend(text, new Date(scheduleAt).toISOString(), replyTarget?.id);
    setDraft('');
    setScheduleAt('');
    setShowSchedule(false);
    onSetReplyTarget(null);
  }

  /** Ends the current recording: sends it, or throws it away. */
  async function finishRecording(send: boolean) {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    recordingTokenRef.current += 1;
    setRecording(false);
    if (!send) {
      recorder.cancel();
      return;
    }
    try {
      const { blob, durationSeconds } = await recorder.stop();
      if (durationSeconds < 1) {
        setRecorderNotice('That recording was too short to send.');
        return;
      }
      onSendVoice(blob, durationSeconds);
    } catch {
      setRecorderNotice('Could not save that recording.');
    }
  }
  finishRecordingRef.current = finishRecording;

  async function toggleRecording() {
    if (recording) {
      await finishRecording(true);
      return;
    }
    if (startingRef.current) return;
    startingRef.current = true;
    setRecorderNotice(null);
    const token = ++recordingTokenRef.current;
    const recorder = new VoiceRecorder();
    try {
      await recorder.start((reason) => {
        setRecorderNotice(reason === 'limit' ? 'Reached the 5 minute limit.' : 'Your microphone was disconnected.');
        void finishRecordingRef.current(true);
      });
      if (token !== recordingTokenRef.current) {
        recorder.cancel(); // the conversation changed while the permission prompt was open
        return;
      }
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      recorder.cancel();
      if (token === recordingTokenRef.current) setRecorderNotice(describeRecorderError(err));
    } finally {
      startingRef.current = false;
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-canvas">
      <header className="border-b border-on-canvas px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-pill bg-lavender text-sm font-medium text-canvas">
            {isGroup ? '\uD83D\uDC65' : (peer?.displayName?.[0]?.toUpperCase() ?? '?')}
          </span>
          <div className="flex-1">
            <p className="text-sm font-medium text-ink-canvas">{headerTitle}</p>
            <p className="text-xs text-ink-canvas-muted">{peerTyping ? 'typing\u2026' : headerSubtitle}</p>
          </div>
          {isGroup && (
            <button onClick={onOpenMembers} className="text-xs text-lavender hover:underline">
              Members
            </button>
          )}
          {!isGroup && peer && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => placeCall('audio')}
                disabled={callDisabledReason !== null}
                aria-label={`Voice call ${peer.displayName}`}
                title={callDisabledReason ?? 'Voice call'}
                className="rounded-pill p-2 text-lavender hover:bg-canvas-alt disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <PhoneIcon className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => placeCall('video')}
                disabled={callDisabledReason !== null}
                aria-label={`Video call ${peer.displayName}`}
                title={callDisabledReason ?? 'Video call'}
                className="rounded-pill p-2 text-lavender hover:bg-canvas-alt disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <VideoIcon className="h-5 w-5" />
              </button>
            </div>
          )}
          <div className="relative">
            <button onClick={() => setShowConvoMenu((v) => !v)} className="text-xs text-lavender hover:underline">
              ⋯
            </button>
            {showConvoMenu && (
              <div className="absolute right-0 z-10 mt-1 w-52 space-y-2 rounded-sm bg-card p-3 text-xs shadow-card">
                <div>
                  <p className="mb-1 font-medium text-ink-card">Disappearing messages</p>
                  <select
                    value={conversation.disappearingSeconds ?? ''}
                    onChange={(e) => onSetDisappearing(e.target.value ? Number(e.target.value) : null)}
                    className="w-full rounded-sm bg-card-alt px-2 py-1 text-ink-card"
                  >
                    {DISAPPEARING_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.seconds ?? ''}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                {!isGroup && (
                  <button onClick={onToggleBlock} className="block w-full text-left text-danger hover:underline">
                    {isPeerBlocked ? 'Unblock' : 'Block'} {peer?.displayName}
                  </button>
                )}
              </div>
            )}
          </div>
          <input
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder="Search this chat…"
            className="w-36 rounded-pill bg-canvas-alt px-3 py-1.5 text-xs text-ink-canvas placeholder:text-ink-canvas-muted outline-none focus:ring-2 focus:ring-coral/40"
          />
        </div>
        {pinnedMessage && (
          <button
            onClick={() => onTogglePin(pinnedMessage.id, true)}
            className="mt-3 flex w-full items-center gap-2 rounded-sm bg-canvas-alt px-3 py-1.5 text-left text-xs text-ink-canvas-muted"
            title="Click to unpin"
          >
            <span>📌</span>
            <span className="truncate">{pinnedMessage.text}</span>
          </button>
        )}
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {hasMoreHistory && (
          <button onClick={onLoadOlder} className="mx-auto block rounded-pill bg-canvas-alt px-4 py-1.5 text-xs text-ink-canvas-muted hover:text-ink-canvas">
            Load older messages
          </button>
        )}
        {visibleMessages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            replyPreview={findById(message.replyToId)}
            pinnedMessageId={pinnedMessageId}
            myUserId={myUserId}
            accessToken={accessToken}
            forwardTargets={forwardTargets}
            onReact={onReact}
            onSetReplyTarget={onSetReplyTarget}
            onToggleStar={onToggleStar}
            onTogglePin={onTogglePin}
            onForward={onForward}
            onEdit={onEdit}
            onDelete={onDelete}
            onReport={onReport}
            onCreateTask={onCreateTaskFromMessage}
            onCreateEvent={onCreateEventFromMessage}
            onCreatePoll={onCreatePollFromMessage}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={showSchedule ? handleScheduleSubmit : handleSubmit} className="border-t border-on-canvas px-6 py-4">
        {replyTarget && (
          <div className="mb-2 flex items-center justify-between rounded-sm bg-canvas-alt px-3 py-1.5 text-xs text-ink-canvas-muted">
            <span className="truncate">Replying to: {replyTarget.text}</span>
            <button onClick={() => onSetReplyTarget(null)} className="ml-2 shrink-0 hover:opacity-70">
              ✕
            </button>
          </div>
        )}
        {pendingFile && (
          <div className="mb-2 flex items-center justify-between rounded-sm bg-canvas-alt px-3 py-1.5 text-xs text-ink-canvas-muted">
            <span className="truncate">📎 {pendingFile.name}</span>
            <div className="flex items-center gap-3">
              {isImageFile(pendingFile) && (
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={sendOriginalQuality} onChange={(e) => setSendOriginalQuality(e.target.checked)} />
                  Original quality
                </label>
              )}
              <button
                onClick={() => {
                  onSendFile(pendingFile, sendOriginalQuality);
                  setPendingFile(null);
                  setSendOriginalQuality(false);
                }}
                className="font-medium text-coral"
              >
                Send
              </button>
              <button onClick={() => setPendingFile(null)} className="hover:opacity-70">
                ✕
              </button>
            </div>
          </div>
        )}
        {showSchedule && (
          <div className="mb-2 flex items-center gap-2 rounded-sm bg-canvas-alt px-3 py-1.5 text-xs text-ink-canvas-muted">
            <span>Send at:</span>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="rounded-sm bg-canvas px-2 py-1 text-ink-canvas"
            />
            <button type="button" onClick={() => setShowSchedule(false)} className="ml-auto hover:opacity-70">
              ✕
            </button>
          </div>
        )}
        {showStickerPicker && (
          <StickerGifPicker
            onPickSticker={(emoji) => {
              onSendSticker(emoji);
              setShowStickerPicker(false);
            }}
            onPickGif={(gif) => {
              onSendGif(gif);
              setShowStickerPicker(false);
            }}
            onSearchGifs={onSearchGifs}
          />
        )}
        {recorderNotice && (
          <p role="status" className="mb-2 text-xs text-danger">
            {recorderNotice}
          </p>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setPendingFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-pill bg-canvas-alt px-3 py-3 text-sm text-ink-canvas-muted hover:text-ink-canvas"
            title="Attach a file or image"
          >
            📎
          </button>
          <button
            type="button"
            onClick={() => setShowStickerPicker((v) => !v)}
            className="rounded-pill bg-canvas-alt px-3 py-3 text-sm text-ink-canvas-muted hover:text-ink-canvas"
            title="Stickers & GIFs"
          >
            😀
          </button>
          {recording && (
            <>
              <span role="timer" className="flex items-center gap-2 text-xs text-danger">
                <span className="h-2 w-2 animate-pulse rounded-pill bg-danger" aria-hidden="true" />
                {formatClock(recordingSeconds)}
              </span>
              <button
                type="button"
                onClick={() => void finishRecording(false)}
                className="rounded-pill bg-canvas-alt px-3 py-3 text-sm text-ink-canvas-muted hover:text-ink-canvas"
                title="Discard recording"
                aria-label="Discard recording"
              >
                {'\u2715'}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={toggleRecording}
            className={`rounded-pill px-3 py-3 text-sm ${recording ? 'bg-danger text-cream' : 'bg-canvas-alt text-ink-canvas-muted hover:text-ink-canvas'}`}
            title={recording ? 'Stop and send voice message' : 'Record a voice message'}
            aria-label={recording ? 'Stop and send voice message' : 'Record a voice message'}
          >
            {recording ? '\u23F9' : '\uD83C\uDFA4'}
          </button>
          <button
            type="button"
            onClick={() => setShowSchedule((v) => !v)}
            className="rounded-pill bg-canvas-alt px-3 py-3 text-sm text-ink-canvas-muted hover:text-ink-canvas"
            title="Schedule this message"
          >
            🕒
          </button>
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onComposerActivity(e.target.value ? 'start' : 'stop');
            }}
            onBlur={() => onComposerActivity('stop')}
            placeholder={showSchedule ? 'Message to schedule\u2026' : 'Type an encrypted message\u2026 (@mention supported)'}
            className="flex-1 rounded-pill bg-cream px-4 py-3 text-sm text-ink-card outline-none ring-coral/40 placeholder:text-ink-card-muted focus:ring-2"
          />
          <button type="submit" className="rounded-pill bg-coral px-6 py-3 text-sm font-medium text-cream shadow-soft hover:bg-coral-hover">
            {showSchedule ? 'Schedule' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  message,
  replyPreview,
  pinnedMessageId,
  myUserId,
  accessToken,
  forwardTargets,
  onReact,
  onSetReplyTarget,
  onToggleStar,
  onTogglePin,
  onForward,
  onEdit,
  onDelete,
  onReport,
  onCreateTask,
  onCreateEvent,
  onCreatePoll,
}: {
  message: DisplayMessage;
  replyPreview: DisplayMessage | undefined;
  pinnedMessageId: string | null;
  myUserId: string;
  accessToken: string;
  forwardTargets: { id: string; label: string }[];
  onReact: (messageId: string, emoji: string) => void;
  onSetReplyTarget: (message: DisplayMessage | null) => void;
  onToggleStar: (messageId: string, currentlyStarred: boolean) => void;
  onTogglePin: (messageId: string, currentlyPinned: boolean) => void;
  onForward: (messageId: string, targetConversationId: string) => void;
  onEdit: (messageId: string, newText: string) => void;
  onDelete: (messageId: string) => void;
  onReport: (messageId: string) => void;
  onCreateTask?: (message: DisplayMessage) => void;
  onCreateEvent?: (message: DisplayMessage) => void;
  onCreatePoll?: (message: DisplayMessage) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.text);
  const [showForwardMenu, setShowForwardMenu] = useState(false);

  const url = message.deletedAt ? null : firstUrlIn(message.text);
  const isSpecial = Boolean(message.media || message.sticker || message.gif);

  // A finished call is a centered system line, not a bubble. It deliberately returns before
  // the action row below, so it cannot be edited, replied to, forwarded, or turned into a task.
  if (message.call && !message.deletedAt) {
    const missedIncoming = !message.mine && message.call.outcome === 'missed';
    return (
      <div className="flex justify-center">
        <span
          className={`flex items-center gap-2 rounded-pill bg-canvas-alt px-4 py-1.5 text-xs ${
            missedIncoming ? 'text-danger' : 'text-ink-canvas-muted'
          }`}
        >
          {message.call.media === 'video' ? <VideoIcon className="h-4 w-4" /> : <PhoneIcon className="h-4 w-4" />}
          <span>{message.text}</span>
          <time dateTime={message.createdAt} className="opacity-70">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </time>
        </span>
      </div>
    );
  }

  function submitEdit() {
    const text = editDraft.trim();
    if (text) onEdit(message.id, text);
    setIsEditing(false);
  }

  return (
    <div className={`group flex ${message.mine ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[70%]">
        <div
          className="rounded-md px-4 py-2 text-sm shadow-soft"
          style={
            message.mine
              ? { backgroundColor: 'var(--color-bubble-outgoing)', color: 'var(--color-bubble-outgoing-text)' }
              : { backgroundColor: 'var(--color-bubble-incoming)', color: 'var(--color-bubble-incoming-text)' }
          }
        >
          {replyPreview && (
            <div className="mb-1 rounded-sm border-l-2 border-current px-2 py-1 text-xs opacity-70">{replyPreview.text}</div>
          )}

          {message.deletedAt ? (
            <p className="italic opacity-60">This message was deleted</p>
          ) : message.media ? (
            <MediaBubble messageId={message.id} media={message.media} accessToken={accessToken} />
          ) : message.sticker ? (
            <span className="block text-5xl leading-none">{message.sticker.emoji}</span>
          ) : message.gif ? (
            // eslint-disable-next-line @next/next/no-img-element -- external GIF CDN, not a local asset
            <img src={message.gif.url} alt="GIF" className="max-h-56 rounded-sm" />
          ) : isEditing ? (
            <div className="space-y-1">
              <input
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitEdit()}
                className="w-full rounded-sm bg-white/20 px-2 py-1 text-sm outline-none"
                autoFocus
              />
              <div className="flex gap-2 text-xs">
                <button onClick={submitEdit} className="underline">
                  Save
                </button>
                <button onClick={() => setIsEditing(false)} className="underline opacity-70">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words">
              <MessageBody text={message.text} />
            </p>
          )}

          {url && !message.deletedAt && <LinkPreviewCard url={url} accessToken={accessToken} />}

          <div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-70">
            {message.editedAt && !message.deletedAt && <span>edited</span>}
            <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            {message.mine && <ReceiptTick status={message.status} />}
          </div>
        </div>

        {Object.keys(message.reactions).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(message.reactions).map(([emoji, userIds]) => (
              <button
                key={emoji}
                onClick={() => onReact(message.id, emoji)}
                className={`rounded-pill px-2 py-0.5 text-xs ${
                  userIds.includes(myUserId) ? 'bg-coral text-cream' : 'bg-canvas-alt text-ink-canvas'
                }`}
              >
                {emoji} {userIds.length}
              </button>
            ))}
          </div>
        )}

        {!message.deletedAt && (
          <div className="mt-1 hidden gap-2 text-[11px] text-ink-canvas-muted group-hover:flex">
            {QUICK_EMOJI.map((emoji) => (
              <button key={emoji} onClick={() => onReact(message.id, emoji)} className="hover:opacity-70">
                {emoji}
              </button>
            ))}
            <button onClick={() => onSetReplyTarget(message)} className="hover:underline">
              Reply
            </button>
            {onCreateTask && !isSpecial && (
              <button onClick={() => onCreateTask(message)} className="hover:underline">
                ☑ Create Task
              </button>
            )}
            {onCreateEvent && !isSpecial && (
              <button onClick={() => onCreateEvent(message)} className="hover:underline">
                📅 Create Event
              </button>
            )}
            {onCreatePoll && !isSpecial && (
              <button onClick={() => onCreatePoll(message)} className="hover:underline">
                📊 Create Poll
              </button>
            )}
            <button onClick={() => onToggleStar(message.id, message.starred)} className="hover:underline">
              {message.starred ? 'Unstar' : 'Star'}
            </button>
            <button onClick={() => onTogglePin(message.id, message.id === pinnedMessageId)} className="hover:underline">
              {message.id === pinnedMessageId ? 'Unpin' : 'Pin'}
            </button>
            {!isSpecial && (
              <div className="relative">
                <button onClick={() => setShowForwardMenu((v) => !v)} className="hover:underline">
                  Forward
                </button>
                {showForwardMenu && (
                  <div className="absolute z-10 mt-1 w-40 rounded-sm bg-card p-1 shadow-card">
                    {forwardTargets.length === 0 && <p className="px-2 py-1 text-ink-card-muted">No other chats</p>}
                    {forwardTargets.map((target) => (
                      <button
                        key={target.id}
                        onClick={() => {
                          onForward(message.id, target.id);
                          setShowForwardMenu(false);
                        }}
                        className="block w-full truncate rounded-sm px-2 py-1 text-left text-ink-card hover:bg-card-alt"
                      >
                        {target.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {message.mine && !isSpecial && (
              <button onClick={() => setIsEditing(true)} className="hover:underline">
                Edit
              </button>
            )}
            {message.mine && (
              <button onClick={() => onDelete(message.id)} className="text-danger hover:underline">
                Delete
              </button>
            )}
            {!message.mine && (
              <button onClick={() => onReport(message.id)} className="hover:underline">
                Report
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function MessageBody({ text }: { text: string }) {
  return (
    <>
      {tokenizeMessageText(text).map((token, i) => {
        if (token.kind === 'mention') return <span key={i} className="font-semibold text-lavender-deep">{token.value}</span>;
        if (token.kind === 'url')
          return (
            <a key={i} href={token.value} target="_blank" rel="noreferrer noopener" className="underline">
              {token.value}
            </a>
          );
        return <span key={i}>{token.value}</span>;
      })}
    </>
  );
}

function ReceiptTick({ status }: { status: DisplayMessage['status'] }) {
  if (status === 'read') return <span title="Read">✓✓</span>;
  if (status === 'delivered') return <span title="Delivered">✓✓</span>;
  return <span title="Sent">✓</span>;
}
