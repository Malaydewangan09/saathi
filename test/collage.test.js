import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkImageUrl, isPrivateAddress } from '../src/collage.js';

const resolveTo = (address) => async () => [{ address, family: 4 }];

test('private and loopback addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.13', '172.20.0.1', '169.254.1.1', '::1', '::ffff:127.0.0.1', '100.64.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['13.32.1.1', '151.101.1.1', '172.32.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('accepts a public https image host', async () => {
  const url = await checkImageUrl('https://m.media-amazon.com/images/I/x.jpg', resolveTo('13.32.1.1'));
  assert.equal(url.hostname, 'm.media-amazon.com');
});

test('refuses http, IP literals, localhost and hosts that resolve to the local network', async () => {
  await assert.rejects(checkImageUrl('http://m.media-amazon.com/x.jpg', resolveTo('13.32.1.1')), /only https/);
  await assert.rejects(checkImageUrl('https://127.0.0.1/x.jpg', resolveTo('127.0.0.1')), /not allowed/);
  await assert.rejects(checkImageUrl('https://localhost/x.jpg', resolveTo('127.0.0.1')), /not allowed/);
  await assert.rejects(checkImageUrl('https://evil.example/x.jpg', resolveTo('192.168.1.1')), /not allowed/);
  await assert.rejects(checkImageUrl('not a url', resolveTo('13.32.1.1')), /not a URL/);
});
