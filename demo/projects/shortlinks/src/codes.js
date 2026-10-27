// Short codes are the base62 encoding of an auto-increment counter.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function encode(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Not a counter value: ${n}`);
  let code = '';
  do {
    code = ALPHABET[n % 62] + code;
    n = Math.floor(n / 62);
  } while (n > 0);
  return code;
}

function decode(code) {
  let n = 0;
  for (const ch of code) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    n = n * 62 + digit;
  }
  return n;
}

module.exports = { encode, decode };
