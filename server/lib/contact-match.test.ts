import { normalizePhone, normalizeEmail, matchKey } from './contact-match'

test('phone normalizes to E.164-ish digits', () => {
  expect(normalizePhone('(503) 555-0199')).toBe('+15035550199')
  expect(normalizePhone('+1 503 555 0199')).toBe('+15035550199')
  expect(normalizePhone('5035550199')).toBe('+15035550199')
  expect(normalizePhone('15035550199')).toBe('+15035550199')
})

test('email lowercases + trims', () => {
  expect(normalizeEmail('  Bob@Email.COM ')).toBe('bob@email.com')
})

test('matchKey prefers phone then email, scoped to location', () => {
  expect(matchKey('locA', { phone: '(503) 555-0199' })).toBe('locA|phone|+15035550199')
  expect(matchKey('locA', { email: 'Bob@x.com' })).toBe('locA|email|bob@x.com')
  expect(matchKey('locA', { phone: '5035550199', email: 'bob@x.com' })).toBe('locA|phone|+15035550199')
  expect(matchKey('locA', {})).toBeNull()
})

test('a digit-free phone does not become a key — it falls through to email then null', () => {
  // junk phones all normalize to a bare "+"; keying on that would merge every
  // such contact into one record. They must not produce a phone key.
  expect(matchKey('locA', { phone: '   ' })).toBeNull()
  expect(matchKey('locA', { phone: '()-' })).toBeNull()
  expect(matchKey('locA', { phone: 'call me' })).toBeNull()
  // a junk phone with a real email keys on the email instead of colliding on "+"
  expect(matchKey('locA', { phone: ' ', email: 'bob@x.com' })).toBe('locA|email|bob@x.com')
})

test('an empty/whitespace email is not a key either', () => {
  expect(matchKey('locA', { email: '   ' })).toBeNull()
  expect(matchKey('locA', { phone: 'xx', email: '' })).toBeNull()
})

test('R14-09: phone normalization boundaries are pinned (no silent identity shifts)', () => {
  // International numbers pass through with a single leading +.
  expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
  expect(normalizePhone('442079460958')).toBe('+442079460958')
  // Stray + signs collapse: only a leading + survives.
  expect(normalizePhone('++1 (503) 555-0199')).toBe('+15035550199')
  expect(normalizePhone('503+555+0199')).toBe('+15035550199')
  // Extension digits are KEPT (documented behavior): an ext changes identity.
  expect(normalizePhone('+15035550199 x123')).toBe('+15035550199123')
  // Non-ASCII digits are stripped (ASCII-only \d): fullwidth digits vanish.
  expect(normalizePhone('５０３５５５０１９９')).toBe('+')
  // Short codes and odd lengths are preserved verbatim behind +.
  expect(normalizePhone('911')).toBe('+911')
  expect(normalizePhone('123456789012345')).toBe('+123456789012345')
})

test('R14-09: email normalization boundaries are pinned', () => {
  // Plus-addressing and dots are preserved: no Gmail-style folding.
  expect(normalizeEmail('Bob+Lead@Email.COM')).toBe('bob+lead@email.com')
  expect(normalizeEmail('  FIRST.LAST@x.io\t')).toBe('first.last@x.io')
  expect(normalizeEmail('UPPER@UPPER.ORG')).toBe('upper@upper.org')
})

test('R14-09: matchKey treats equivalent spellings as one identity', () => {
  const a = matchKey('locA', { phone: '(503) 555-0199' })
  const b = matchKey('locA', { phone: '+1-503-555-0199' })
  expect(a).toBe(b)
  const c = matchKey('locA', { email: 'Bob@x.com' })
  const d = matchKey('locA', { email: '  BOB@X.COM ' })
  expect(c).toBe(d)
  // ...but distinct identifiers stay distinct, and locations never share keys.
  expect(matchKey('locA', { phone: '5035550199' })).not.toBe(matchKey('locA', { phone: '5035550200' }))
  expect(matchKey('locA', { phone: '5035550199' })).not.toBe(matchKey('locB', { phone: '5035550199' }))
})
