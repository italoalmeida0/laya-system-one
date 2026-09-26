/**
 * Unit tests for prompt construction (src/tokenizer.js) using a stub
 * tokenizer — no model files required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  QTYPES,
  serializeState,
  renderCriterion,
  renderOptions,
  buildSequence
} from '../../src/tokenizer.js';
import { fakeTokenizer } from '../helpers/index.js';

test('QTYPES: stable wire ids (choice=0, score=1, noul=2)', () => {
  assert.deepEqual(QTYPES, { choice: 0, score: 1, noul: 2 });
});

test('serializeState: strings pass through, structures become JSON', () => {
  assert.equal(serializeState('hello'), 'hello');
  assert.equal(serializeState({ a: 1 }), '{"a":1}');
  assert.equal(serializeState([1, 2]), '[1,2]');
});

test('renderCriterion: strings unchanged, objects JSON-encoded', () => {
  assert.equal(renderCriterion('text'), 'text');
  assert.equal(renderCriterion({ k: 'v' }), '{"k":"v"}');
});

test('renderOptions: choice renders bare labels when criteria are empty', () => {
  const opts = renderOptions({ t: 'choice', crit: { billing: null, tech: '' } });
  assert.deepEqual(opts, ['billing', 'tech']);
});

test('renderOptions: choice renders "label: criteria" when criteria exist', () => {
  const opts = renderOptions({ t: 'choice', crit: { billing: 'invoices' } });
  assert.deepEqual(opts, ['billing: invoices']);
});

test('renderOptions: score renders ordered levels', () => {
  const arr = renderOptions({ t: 'score', crit: ['low', 'high'] });
  assert.deepEqual(arr, ['level 0: low', 'level 1: high']);

  const map = renderOptions({ t: 'score', crit: { 0: 'low', 2: 'high' } });
  assert.deepEqual(map, ['level 0: low', 'level 2: high']);
});

test('renderOptions: noul falls back to default false/true text', () => {
  const opts = renderOptions({ t: 'noul', crit: {} });
  assert.deepEqual(opts, [
    'false: no, the statement does not hold',
    'true: yes, the statement holds'
  ]);
});

test('renderOptions: noul accepts custom criteria text', () => {
  const opts = renderOptions({ t: 'noul', crit: { false: 'not refund', true: 'refund' } });
  assert.deepEqual(opts, ['false: not refund', 'true: refund']);
});

test('buildSequence: deterministic layout with markers on every option', () => {
  const tok = fakeTokenizer();
  const q = { t: 'choice', ins: 'pick one', crit: { a: null, b: null, c: null } };

  const first = buildSequence(tok, 'state text', q, 128, 64);
  const second = buildSequence(tok, 'state text', q, 128, 64);

  assert.deepEqual(first.ids, second.ids, 'same input must produce the same ids');
  assert.deepEqual(first.markers, second.markers);
  assert.equal(first.ids[0], tok.cls_token_id);
  assert.equal(first.ids[first.ids.length - 1], tok.sep_token_id);
  assert.equal(first.markers.length, 3);
  for (const m of first.markers) assert.equal(first.ids[m], tok.mask_token_id);
});

test('buildSequence: markers are strictly increasing', () => {
  const tok = fakeTokenizer();
  const q = { t: 'choice', ins: 'which?', crit: { x: null, y: null, z: null, w: null } };
  const { markers } = buildSequence(tok, 'abc', q, 128, 64);
  for (let i = 1; i < markers.length; i++) {
    assert.ok(markers[i] > markers[i - 1]);
  }
});

test('buildSequence: maxLen is never exceeded even with a huge state', () => {
  const tok = fakeTokenizer();
  const q = { t: 'choice', ins: 'pick', crit: { a: null, b: null } };
  const { ids, markers } = buildSequence(tok, 'word '.repeat(2000), q, 40, 32);
  assert.ok(ids.length <= 40, `got ${ids.length} ids`);
  for (const m of markers) assert.ok(m < 40, 'markers outside the window are dropped');
});

test('buildSequence: option list is capped by head_max_len', () => {
  const tok = fakeTokenizer();
  const crit = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`option_${i}`, null]));
  const q = { t: 'choice', ins: 'pick among many', crit };
  const { ids, markers } = buildSequence(tok, 'state', q, 256, 48);
  assert.ok(ids.length <= 256);
  assert.ok(markers.length <= 30);
  // head segment (before the first marker) stays within the head budget
  assert.ok(markers[0] <= 48 + 2, `head too long: ${markers[0]}`);
});

test('buildSequence: mask tokens inside instructions/state are stripped', () => {
  const tok = fakeTokenizer();
  const q = { t: 'choice', ins: 'is <mask> present', crit: { a: null } };
  const { ids } = buildSequence(tok, 'state <mask> text', q, 64, 32);
  // the only remaining [MASK] is the option marker itself
  const maskCount = ids.filter((id) => id === tok.mask_token_id).length;
  assert.equal(maskCount, 1);
});

test('buildSequence: empty options still produce a valid sequence', () => {
  const tok = fakeTokenizer();
  const q = { t: 'noul', ins: 'yes or no', crit: {} };
  const { ids, markers } = buildSequence(tok, 'state', q, 64, 32);
  assert.equal(markers.length, 2);
  assert.ok(ids.length > markers[markers.length - 1]);
});

test('buildSequence: repeated identical prompts hit the encode cache', () => {
  const tok = fakeTokenizer();
  let calls = 0;
  const counting = (text, opts) => { calls++; return tok(text, opts); };
  Object.assign(counting, tok);

  const q = { t: 'choice', ins: 'same instructions', crit: { a: null, b: null } };
  buildSequence(counting, 'state one', q, 128, 64);
  const callsAfterFirst = calls;
  buildSequence(counting, 'state two', q, 128, 64);

  // the state differs, so exactly one new encode is expected
  assert.equal(calls - callsAfterFirst, 1, `expected 1 new encode, got ${calls - callsAfterFirst}`);
});
