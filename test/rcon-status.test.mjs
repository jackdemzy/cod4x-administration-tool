import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { parseStatus, cleanName, nameMatches } from '../lib/rcon-status.mjs';

test('parses the real CoD4x 21 status with two bots', async () => {
  const status = parseStatus(await fs.readFile(new URL('./fixtures/cod4x-status-bots.txt', import.meta.url), 'latin1'));
  assert.equal(status.map, 'mp_backlot');
  assert.deepEqual(status.players.map(row => [row.slot, row.name, row.playerid, row.bot, row.ping, row.address]), [[0, 'bot0', '0', true, 0, 'bot'], [1, 'bot1', '0', true, 0, 'bot']]);
});

test('names with spaces, colour codes and digits are parsed from the right', () => {
  const text = 'map     : mp_crash\n\nnum score ping playerid steamid name lastmsg address qport rate\n--- ----- ---- -----\n'
    + '  3    12   48 1234567890          7654321           ^1Big ^7Bad Wolf 42^7                       0 203.0.113.7:28960                                     1234 25000\n'
    + '  5     0 CNCT 2345678901          0                 New Player^7                             50 198.51.100.9:28960                                    4321  5000\n';
  const { map, players } = parseStatus(text);
  assert.equal(map, 'mp_crash');
  assert.deepEqual(players[0], { slot: 3, score: 12, ping: 48, playerid: '1234567890', steamid: '7654321', name: 'Big Bad Wolf 42', rawName: '^1Big ^7Bad Wolf 42^7', lastmsg: 0, address: '203.0.113.7:28960', bot: false, qport: 1234, rate: 25000 });
  assert.equal(players[1].ping, 'CNCT');
  assert.equal(players[1].name, 'New Player');
  assert.deepEqual(parseStatus('Server is not running.\n').players, []);
});

test('cleanName removes colour codes', () => {
  assert.equal(cleanName('^1Big ^7Bad^7'), 'Big Bad');
  assert.equal(cleanName('plain'), 'plain');
});

test('b3hide status: bots, a truncated colour name, numeric ping and the limits', async () => {
  const text = await fs.readFile(new URL('./fixtures/cod4x-status-b3hide.txt', import.meta.url), 'latin1');
  const status = parseStatus(text, { format: 'b3hide' });
  assert.equal(status.format, 'b3hide');
  assert.deepEqual(status.limits, { nameLength: 15, connectionState: false });
  assert.equal(status.map, 'mp_backlot');
  assert.deepEqual(status.players.map(player => [player.slot, player.name, player.bot, player.ping]), [[0, 'bot0', true, 0], [1, 'bot1', true, 0], [4, 'VeryLongPlaye', false, 48]]);
  assert.deepEqual([status.players[2].playerid, status.players[2].address, status.players[2].qport], ['2310346613472386', '203.0.113.7:28960', 4321]);
  assert.equal(parseStatus(text).format, 'core');
});

test('b3hide name match compares only the cut prefix of long names', () => {
  assert.equal(nameMatches({ name: 'VeryLongPlaye', rawName: '^1VeryLongPlaye^7' }, 'VeryLongPlayerName', 'b3hide'), true);
  assert.equal(nameMatches({ name: 'VeryLongPlaye', rawName: '^1VeryLongPlaye^7' }, 'VeryLongPlayerName', 'core'), false);
  assert.equal(nameMatches({ name: 'Wolf', rawName: 'Wolf^7' }, 'Wolfgang', 'b3hide'), false);
  assert.equal(nameMatches({ name: 'Wolf', rawName: 'Wolf^7' }, 'Wolf', 'b3hide'), true);
});
