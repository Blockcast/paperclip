import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMuxer } from '../check-ffmpeg-muxer.mjs';

// Representative `ffmpeg -hide_banner -muxers` output shape (BLO-23128).
const MUXERS_OUTPUT = `Muxers:
 D. = Demuxing supported
 .E = Muxing supported
 --
  E mmt             MMT (MPEG Media Transport)
  E moq             MOQ (Media over QUIC)
  E moq_mmt         MOQ with MMTP packaging and RaptorQ FEC
  E dash            DASH Muxer
  E tee             Multiple muxer tee
`;

test('finds a muxer present in the list', () => {
  assert.equal(hasMuxer(MUXERS_OUTPUT, 'moq_mmt'), true);
});

test('reports a missing muxer as absent', () => {
  const withoutMoqMmt = MUXERS_OUTPUT.split('\n').filter(l => !l.includes('moq_mmt')).join('\n');
  assert.equal(hasMuxer(withoutMoqMmt, 'moq_mmt'), false);
});

test('does not false-positive on a muxer name that is a prefix of another', () => {
  // "moq" must not match when only "moq_mmt" (and not standalone "moq") is present.
  const onlyMoqMmt = MUXERS_OUTPUT.split('\n').filter(l => !/ moq /.test(l)).join('\n');
  assert.equal(hasMuxer(onlyMoqMmt, 'moq'), false);
  assert.equal(hasMuxer(onlyMoqMmt, 'moq_mmt'), true);
});

test('does not false-positive on a muxer name that is a suffix of another', () => {
  const withoutBareMmt = MUXERS_OUTPUT.split('\n').filter(l => !/ mmt /.test(l)).join('\n');
  assert.equal(hasMuxer(withoutBareMmt, 'mmt'), false);
  assert.equal(hasMuxer(withoutBareMmt, 'moq_mmt'), true);
});

test('matches at the very start or end of the output, not just mid-line', () => {
  assert.equal(hasMuxer('moq_mmt', 'moq_mmt'), true);
  assert.equal(hasMuxer('  E moq_mmt', 'moq_mmt'), true);
});

test('returns false for empty output (e.g. a failed docker pull/run)', () => {
  assert.equal(hasMuxer('', 'moq_mmt'), false);
});
