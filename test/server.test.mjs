import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, safeTarget } from '../scripts/sources-server.mjs';

test('社内・自分自身の宛先は開かない', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  for (const u of ['http://localhost/', 'http://localhost./', 'http://127.0.0.1/', 'http://[::1]/', 'http://metadata.google.internal./', 'http://example.com:8080/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://127.0.0.1.nip.io/'])
    assert.equal(await safeTarget(u), false, u);
});
