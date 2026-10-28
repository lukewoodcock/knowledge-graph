# notes-api

A tiny REST API for notes on Node's built-in `http` module, with no
dependencies. Notes are kept in `data/notes.json`.

```bash
npm start
curl -s -X POST localhost:4000/notes -d '{"title":"First note"}'
curl -s localhost:4000/notes
```

Keep it dependency-free: plain Node.js, CommonJS, no npm packages.
