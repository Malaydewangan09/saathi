import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, parseAgentOutput } from '../src/agent.js';

test('first turn starts a new session, later turns resume it', () => {
  assert.ok(!buildArgs({}).includes('--resume'));
  const args = buildArgs({ sessionId: 'abc' });
  assert.equal(args[args.indexOf('--resume') + 1], 'abc');
});

test('agent only gets browser tools', () => {
  const args = buildArgs({});
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__browser');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
});

test('parses structured output and session id', () => {
  const out = JSON.stringify({
    is_error: false,
    session_id: 's1',
    structured_output: { status: 'done', spoken: 'मिल गई', card: '22185', approval_summary: '', amount_inr: 0, family_note: '' },
  });
  const { reply, sessionId } = parseAgentOutput(out);
  assert.equal(sessionId, 's1');
  assert.equal(reply.card, '22185');
});

test('surfaces agent errors', () => {
  assert.throws(() => parseAgentOutput(JSON.stringify({ is_error: true, result: 'rate limited' })), /rate limited/);
  assert.throws(() => parseAgentOutput('not json'), /not JSON/);
});
