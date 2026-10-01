import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillCreateData, fillUpdateData } from '../src/lib/nullParity.js';

/**
 * These run against the real generated schema metadata (Prisma.dmmf), so they fail if a
 * schema change ever breaks the guarantee that optional fields are stored as null.
 */

type Doc = Record<string, unknown>;

test('top-level create fills every unset optional scalar with null', () => {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const out = fillCreateData('Message', {
    conversationId: 'c1',
    senderId: 'u1',
    type: 'TEXT',
    ciphertext: 's2.x',
    olmMessageType: 0,
    sessionRef: 'e2:c1:d1',
    replyToId: undefined,
    expiresAt: undefined,
    createdAt,
  }) as Doc;

  for (const field of ['replyToId', 'editedAt', 'deletedAt', 'expiresAt', 'scheduledFor']) {
    assert.equal(out[field], null, `${field} is explicitly null`);
  }
  assert.equal(out.createdAt, createdAt, 'provided values are kept as-is');
  assert.equal(out.ciphertext, 's2.x');
});

test('values the caller provided, including explicit null, are never overwritten', () => {
  const expiresAt = new Date();
  const out = fillCreateData('Message', { expiresAt, deletedAt: null, replyToId: 'm0' }) as Doc;
  assert.equal(out.expiresAt, expiresAt);
  assert.equal(out.deletedAt, null);
  assert.equal(out.replyToId, 'm0');
});

test('nested creates are filled, but never with the foreign key the parent supplies', () => {
  const out = fillCreateData('Conversation', {
    type: 'DIRECT',
    members: { create: [{ userId: 'a' }, { userId: 'b', role: 'OWNER' }] },
  }) as Doc;

  assert.equal(out.title, null);
  assert.equal(out.disappearingSeconds, null);
  const members = (out.members as { create: Doc[] }).create;
  assert.equal(members.length, 2);
  for (const member of members) {
    assert.equal(member.mutedUntil, null);
    assert.ok(!('conversationId' in member), 'back-reference FK is left to Prisma');
  }
  assert.equal(members[1].role, 'OWNER');
});

test('media created inside a message gets folderId null (the "unfiled" filter depends on it)', () => {
  const out = fillCreateData('Message', {
    conversationId: 'c1',
    media: { create: { storageKey: 'k', sizeBytes: 1, contentHash: 'h', mimeTypeGuess: 'image/jpeg' } },
  }) as Doc;
  const media = (out.media as { create: Doc }).create;
  assert.equal(media.folderId, null);
  assert.equal(media.mimeTypeGuess, 'image/jpeg');
  assert.ok(!('messageId' in media));
});

test('checked (connect-style) input never receives foreign-key scalars', () => {
  const out = fillCreateData('Task', {
    workspace: { connect: { id: 'w1' } },
    createdBy: { connect: { id: 'u1' } },
    titleCiphertext: 't',
    sessionRef: 's',
  }) as Doc;
  assert.ok(!('assigneeId' in out), 'mixing assigneeId into checked input would be rejected by Prisma');
  assert.ok(!('workspaceId' in out));
  assert.equal(out.descriptionCiphertext, null);
  assert.equal(out.dueDate, null);
  assert.equal(out.completedAt, null);
});

test('unchecked (raw foreign key) input gets optional foreign keys filled', () => {
  const out = fillCreateData('Task', { workspaceId: 'w1', createdById: 'u1', titleCiphertext: 't', sessionRef: 's' }) as Doc;
  assert.equal(out.assigneeId, null);
  assert.equal(out.sourceMessageId, null);
});

test('self-relation nested create does not set the parent pointer', () => {
  const out = fillCreateData('Folder', {
    workspaceId: 'w1',
    nameCiphertext: 'n',
    sessionRef: 's',
    children: { create: { workspaceId: 'w1', nameCiphertext: 'c', sessionRef: 's' } },
  }) as Doc;
  assert.equal(out.parentId, null, 'a top-level folder has no parent');
  const child = (out.children as { create: Doc }).create;
  assert.ok(!('parentId' in child), 'the child parent pointer is supplied by Prisma');
});

test('update payloads keep undefined as "leave unchanged" but nested creates are filled', () => {
  const update = fillUpdateData('Conversation', {
    title: undefined,
    members: { create: { userId: 'c' } },
  }) as Doc;
  assert.ok('title' in update && update.title === undefined, 'scalar updates are untouched');
  assert.equal(((update.members as { create: Doc }).create).mutedUntil, null);

  const plain = { editedAt: new Date() };
  assert.equal(fillUpdateData('Message', plain), plain, 'updates without nested writes pass through unchanged');
});

test('upsert-style create payloads are filled', () => {
  const out = fillCreateData('MessageReceipt', { messageId: 'm', userId: 'u', deliveredAt: new Date() }) as Doc;
  assert.equal(out.readAt, null);
});

test('unknown models and non-object data pass through untouched', () => {
  const input = { a: 1 };
  assert.equal(fillCreateData('NoSuchModel', input), input);
  assert.equal(fillCreateData('Message', null), null);
});
