const http = require('http');
const fs = require('fs');
const path = require('path');
const base = __dirname;
const mime = { html:'text/html', js:'text/javascript', css:'text/css', woff2:'font/woff2' };

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

const SYSTEM_PROMPT = `你叫"字灵"，是一个汉字精灵。用户会和你聊天。你只用 JSON 回复，不加解释或 Markdown。

JSON 格式：
{
  "quickReply": "简洁回应（20字内）",
  "megachar": {
    "chars": ["字1"],
    "direction": "horizontal",
    "rotateInterval": 2000,
    "duration": 6000
  },
  "stream": [
    {"text": "回复段1", "emoji": "^_^"},
    {"text": "回复段2", "emoji": ">=v<="}
  ]
}

stream 是 2-4 段话，每段配一个颜文字。可选颜文字：^_^, -_-, T_T, Q_Q, U_U, >_<, >=<=, not_not, =_=, ^o^, ^.^, >=v<=, ^_^/
megachar 选和对话相关的汉字。`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonReply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  if (url === '/api/ping' && req.method === 'GET') {
    jsonReply(res, 200, { status: 'ok' });
    return;
  }

  if (url === '/api/chat' && req.method === 'POST') {
    if (!DEEPSEEK_API_KEY) {
      jsonReply(res, 500, { error: 'API key not configured' });
      return;
    }

    readBody(req).then(async (body) => {
      const message = body.message || '';

      try {
        const aiRes = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
          },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: message }
            ],
            response_format: { type: 'json_object' },
            max_tokens: 2048,
            temperature: 0.7,
            stream: false
          })
        });

        if (!aiRes.ok) {
          jsonReply(res, 500, { error: `DeepSeek API error: ${aiRes.status}` });
          return;
        }

        const aiData = await aiRes.json();
        const rawContent = aiData.choices?.[0]?.message?.content || '';

        let parsed;
        try {
          parsed = JSON.parse(rawContent);
        } catch {
          parsed = { quickReply: rawContent.slice(0, 100) };
        }

        jsonReply(res, 200, parsed);
      } catch {
        jsonReply(res, 500, { error: 'AI request failed' });
      }
    }).catch(() => {
      jsonReply(res, 400, { error: 'Invalid request body' });
    });
    return;
  }

  let f = url;
  if (f === '/') f = '/index.html';
  try {
    const d = fs.readFileSync(path.join(base, f));
    const e = path.extname(f).slice(1);
    res.writeHead(200, { 'Content-Type': mime[e] || 'text/plain' });
    res.end(d);
  } catch { res.writeHead(404); res.end('404'); }
}).listen(8080, () => console.log('Server on 8080'));
