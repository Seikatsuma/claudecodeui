import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatTitlePrompt,
  CHAT_TITLE_MAX_CHARS,
  cleanGeneratedTitle,
} from '@/modules/providers/list/devin/devin-title.js';

test('cleanGeneratedTitle keeps a short front-loaded answer verbatim', () => {
  assert.equal(cleanGeneratedTitle('25 ГБ — версии Code UI'), '25 ГБ — версии Code UI');
});

test('cleanGeneratedTitle strips quotes, trailing punctuation and extra lines', () => {
  assert.equal(cleanGeneratedTitle('«Devin — названия чатов».\nВот пояснение.'), 'Devin — названия чатов');
});

test('cleanGeneratedTitle truncates overlong answers at a word boundary', () => {
  const long = 'Очень длинное название которое точно не влезет в узкую панель слева чатов';
  const cleaned = cleanGeneratedTitle(long);
  assert.ok(cleaned);
  assert.ok(cleaned.length <= CHAT_TITLE_MAX_CHARS);
  assert.ok(!cleaned.endsWith(' '), 'no trailing space');
  assert.match(cleaned, /\S$/, 'cut lands after a word, not mid-word');
});

test('cleanGeneratedTitle rejects junk: tool calls, JSON, blanks', () => {
  assert.equal(cleanGeneratedTitle('functions.read_file:0{"file_path": "/x"}'), null);
  assert.equal(cleanGeneratedTitle('Читаю файл.functions.ReadImage:0{"uri": "/x"}'), null);
  assert.equal(cleanGeneratedTitle('{"ok":1}'), null);
  assert.equal(cleanGeneratedTitle('["a","b"]'), null);
  assert.equal(cleanGeneratedTitle('   '), null);
  assert.equal(cleanGeneratedTitle('я'), null);
});

test('cleanGeneratedTitle rejects an echo of the first user message', () => {
  const first = 'Отвечай ТОЛЬКО JSON-объектом по запрошенной схеме — без markdown';
  assert.equal(cleanGeneratedTitle('Отвечай ТОЛЬКО JSON-объектом', first), null);
  assert.equal(cleanGeneratedTitle('Схема JSON-ответов', first), 'Схема JSON-ответов');
});

test('buildChatTitlePrompt carries the draft title and the first messages', () => {
  const prompt = buildChatTitlePrompt({
    devinTitle: 'Code UI версии на сервере Осии Криблеевой занимают 25 ГБ',
    userMessages: [
      'Слушай, почему-то у Осии версии code UI на сервере едят 25 гигов',
      'Проверь подробнее',
      'И ещё вопрос',
      'Четвёртое не попадает',
    ],
  });
  assert.match(prompt, /Code UI версии на сервере Осии/);
  assert.match(prompt, /едят 25 гигов/);
  assert.match(prompt, /И ещё вопрос/);
  assert.doesNotMatch(prompt, /Четвёртое не попадает/);
});

test('buildChatTitlePrompt works without a draft title', () => {
  const prompt = buildChatTitlePrompt({ userMessages: ['Почини авторизацию'] });
  assert.doesNotMatch(prompt, /Черновое название/);
  assert.match(prompt, /Почини авторизацию/);
});
