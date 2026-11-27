import assert from 'node:assert/strict';
import test from 'node:test';
import { accountKey, normalizeIdentity, parseMoodleDeadline, validatePortalLink } from './security';

test('account namespaces bind normalized identity and portal without accepting path input', () => {
  assert.equal(normalizeIdentity(' Student@Example.Invalid '), 'student@example.invalid');
  assert.equal(accountKey('personal', 'https://aula.invalid/2026B/', 'Student@Example.Invalid'), accountKey('personal', 'https://aula.invalid/2026B/', 'student@example.invalid'));
  assert.notEqual(accountKey('personal', 'https://aula.invalid/2026B/', 'one@example.invalid'), accountKey('personal', 'https://aula.invalid/2026B/', 'two@example.invalid'));
  assert.throws(() => normalizeIdentity('../profile'));
  assert.throws(() => normalizeIdentity(''));
});
test('navigation stays within the configured portal period and rejects mutation during capture', () => {
  const portal = 'https://aula.invalid/2099B/';
  assert.equal(validatePortalLink('/2099B/mod/assign/view.php?id=3', portal, true), portal + 'mod/assign/view.php?id=3');
  for (const link of ['//evil.invalid/2099B/', '/2026B/my/', '/2099B/login/logout.php', '/2099B/mod/assign/view.php?id=3&action=submit', 'https://user@aula.invalid/2099B/']) assert.equal(validatePortalLink(link, portal, true), null);
});
test('Moodle deadlines keep unknown safe and parse Spanish Lima dates', () => {
  assert.equal(parseMoodleDeadline('sábado, 5 de diciembre de 2026, 23:59'), '2026-12-06T04:59:00.000Z');
  assert.equal(parseMoodleDeadline('5 de diciembre de 2026'), '2026-12-05');
  assert.equal(parseMoodleDeadline('fecha no disponible'), null);
  assert.equal(parseMoodleDeadline('31 de febrero de 2026, 23:59'), null);
});

test('Moodle deadlines parse Moodle 4.x labels, 12-hour times, and abbreviated Spanish months', () => {
  assert.equal(parseMoodleDeadline('domingo, 29 de noviembre de 2026, 23:59'), '2026-11-30T04:59:00.000Z');
  assert.equal(parseMoodleDeadline('29 nov 2026, 11:59 p. m.'), '2026-11-30T04:59:00.000Z');
  assert.equal(parseMoodleDeadline('Cierre: lunes, 7 de diciembre de 2026, 23:59'), '2026-12-08T04:59:00.000Z');
  assert.equal(parseMoodleDeadline('29 nov 2026, 11:59 pm'), '2026-11-30T04:59:00.000Z');
  assert.equal(parseMoodleDeadline('29 nov 2026, 11:59 a. m.'), '2026-11-29T16:59:00.000Z');
  assert.equal(parseMoodleDeadline('29 nov 2026, 12:00 am'), '2026-11-29T05:00:00.000Z');
  assert.equal(parseMoodleDeadline('29 nov 2026, 12:30 p. m.'), '2026-11-29T17:30:00.000Z');
  assert.equal(parseMoodleDeadline('29 nov\u00a02026, 11:59\u00a0p.\u00a0m.'), '2026-11-30T04:59:00.000Z');
  assert.equal(parseMoodleDeadline('29 nov 2026, 13:00 pm'), null);
  assert.equal(parseMoodleDeadline('29 nov 2026, 0:30 am'), null);

  const abbreviated: Array<[string, string]> = [
    ['10 ene 2026', '2026-01-10'],
    ['10 feb 2026', '2026-02-10'],
    ['10 mar 2026', '2026-03-10'],
    ['10 abr 2026', '2026-04-10'],
    ['10 may 2026', '2026-05-10'],
    ['10 jun 2026', '2026-06-10'],
    ['10 jul 2026', '2026-07-10'],
    ['10 ago 2026', '2026-08-10'],
    ['10 sep 2026', '2026-09-10'],
    ['10 sept. 2026', '2026-09-10'],
    ['10 oct 2026', '2026-10-10'],
    ['10 nov 2026', '2026-11-10'],
    ['10 dic 2026', '2026-12-10'],
  ];
  for (const [input, expected] of abbreviated) {
    assert.equal(parseMoodleDeadline(input), expected, `Expected "${input}" to parse as ${expected}`);
  }
});
