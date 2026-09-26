import assert from 'node:assert/strict';
import test from 'node:test';

import { clearAttachmentDraft, stashAttachmentDraft, takeAttachmentDraft } from './attachmentDrafts';

const file = (name: string) => new File(['x'], name, { type: 'image/png' });

test('картинки чата А не попадают в чат Б и возвращаются в А', () => {
  const shot = file('a.png');
  stashAttachmentDraft('chat-a', { files: [shot], uploaded: [] });
  assert.deepEqual(takeAttachmentDraft('chat-b').files, []);
  assert.deepEqual(takeAttachmentDraft('chat-a').files, [shot]);
  // Забрали — дальше они живут в поле, повторно не всплывают.
  assert.deepEqual(takeAttachmentDraft('chat-a').files, []);
});

test('загруженные описания из правки очереди тоже принадлежат чату', () => {
  stashAttachmentDraft('chat-a', { files: [], uploaded: [{ name: 'x.png' }] });
  assert.deepEqual(takeAttachmentDraft('chat-a').uploaded, [{ name: 'x.png' }]);
});

test('пустое поле стирает спрятанное, отправка чистит черновик ушедшего чата', () => {
  stashAttachmentDraft('chat-a', { files: [file('a.png')], uploaded: [] });
  stashAttachmentDraft('chat-a', { files: [], uploaded: [] });
  assert.deepEqual(takeAttachmentDraft('chat-a').files, []);

  stashAttachmentDraft('chat-a', { files: [file('a.png')], uploaded: [] });
  clearAttachmentDraft('chat-a');
  assert.deepEqual(takeAttachmentDraft('chat-a').files, []);
});

test('без области ничего не хранится', () => {
  stashAttachmentDraft(null, { files: [file('a.png')], uploaded: [] });
  assert.deepEqual(takeAttachmentDraft(null), { files: [], uploaded: [] });
});
