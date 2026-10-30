#!/usr/bin/env node
// 从 chinese-poetry 仓库拉取《全唐诗》，核对清单、补缺、校验 JSON。
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const RAW = path.join(__dirname, '..', 'raw');
const DIR_ENC = '%E5%85%A8%E5%94%90%E8%AF%97'; // 全唐诗
const BASE = 'https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/' + DIR_ENC + '/';

function fetch(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'tang-sky-build' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4)
        return resolve(fetch(res.headers.location, redirects + 1));
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getExpectedList() {
  const api = 'https://api.github.com/repos/chinese-poetry/chinese-poetry/git/trees/master?recursive=1';
  const buf = await fetch(api);
  const tree = JSON.parse(buf.toString('utf8')).tree;
  return tree
    .filter(t => t.type === 'blob' && t.path.startsWith('全唐诗/') && !t.path.includes('/error/'))
    .map(t => t.path.split('/').pop());
}

async function downloadOne(name) {
  const buf = await fetch(BASE + name);
  JSON.parse(buf.toString('utf8')); // 先验证再落盘
  fs.writeFileSync(path.join(RAW, name), buf);
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  console.log('fetching file list...');
  const expected = await getExpectedList();
  console.log('expected:', expected.length, 'files');

  for (let round = 1; round <= 4; round++) {
    const missing = [], broken = [];
    for (const name of expected) {
      const p = path.join(RAW, name);
      if (!fs.existsSync(p)) { missing.push(name); continue; }
      try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch { broken.push(name); }
    }
    console.log(`round ${round}: missing=${missing.length} broken=${broken.length}`);
    if (!missing.length && !broken.length) break;
    const todo = [...missing, ...broken];
    // 并行 8 路
    const queue = [...todo];
    let done = 0, fail = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const name = queue.shift();
        try { await downloadOne(name); } catch (e) { fail++; console.error('  fail:', name, e.message.slice(0, 60)); }
        done++;
        if (done % 10 === 0) console.log(`  ${done}/${todo.length}`);
      }
    }));
    if (fail && round === 4) process.exit(1);
    await new Promise(r => setTimeout(r, 1500));
  }
  const files = fs.readdirSync(RAW).filter(f => f.endsWith('.json'));
  console.log('final:', files.length, 'json files in raw/');
}

main().catch(e => { console.error(e); process.exit(1); });
