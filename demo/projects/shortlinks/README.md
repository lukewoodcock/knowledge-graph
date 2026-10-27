# shortlinks

A tiny URL shortener on Node's built-in `http` module, with no dependencies.

```bash
npm start
curl -s -X POST localhost:3000/links -d '{"url":"https://example.com"}'
# {"code":"0","url":"https://example.com/"}
curl -si localhost:3000/0 | head -2
```

Keep it dependency-free: plain Node.js, CommonJS, no npm packages.
