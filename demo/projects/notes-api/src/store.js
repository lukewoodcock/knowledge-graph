// Notes in one JSON file, rewritten through a temporary file and a rename.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.NOTES_FILE || path.join(__dirname, '..', 'data', 'notes.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(notes) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
  fs.renameSync(tmp, FILE);
}

function list() {
  return load().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function get(id) {
  return load().find(n => n.id === id);
}

function create({ title, body = '' }) {
  const note = { id: crypto.randomUUID(), title, body, createdAt: new Date().toISOString() };
  save([...load(), note]);
  return note;
}

module.exports = { list, get, create };
