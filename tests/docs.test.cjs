const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('介绍页面和主 README 统一为中文，旧中文地址仍可使用', () => {
  const readme = read('README.md'), index = read('index.html');
  assert.match(readme, /^# YouTube 双语字幕/);
  assert.match(index, /<html lang="zh-CN">/);
  assert.doesNotMatch(readme + index, /Quick start|# YouTube Bilingual|Languages:|This script translates English/);
  assert.doesNotMatch(index, /lang-switch|href="zh.html"/);
  assert.match(read('README.zh-CN.md'), /\[README.md\]\(README.md\)/);
  assert.match(read('zh.html'), /http-equiv="refresh" content="0; url=index.html"/);
});

test('文档、介绍页、脚本和包版本一致', () => {
  const version = JSON.parse(read('package.json')).version;
  assert.ok(read('youtube-bilingual-subs.user.js').includes(`// @version      ${version}`));
  assert.ok(read('README.md').includes(`更新到 ${version}`));
  assert.ok(read('index.html').includes(`当前版本 ${version}`));
});

test('模型升级和隐私说明与实际行为一致', () => {
  const readme = read('README.md');
  assert.match(readme, /deepseek-flash/);
  assert.match(readme, /DeepSeek-V4\.1-Flash-1017/);
  assert.match(readme, /thinking: \{ type: 'disabled' \}/);
  assert.match(readme, /字幕原文会发送给当前选定的翻译服务/);
  assert.doesNotMatch(readme, /不上传任何服务器|所有数据.*不上传/);
});

test('介绍页和 README 的相对文件链接均有效', () => {
  for (const file of ['index.html', 'zh.html', 'README.md', 'README.zh-CN.md']) {
    const text = read(file);
    const links = file.endsWith('.html')
      ? [...text.matchAll(/href="([^"]+)"/g)].map(match => match[1])
      : [...text.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
    for (const link of links) {
      if (/^(https?:|#)/.test(link)) continue;
      assert.ok(fs.existsSync(path.join(root, link.split('#')[0])), `${file} 中的链接不存在：${link}`);
    }
  }
});

test('CI 在支持的 Node 版本上运行语法检查和完整测试', () => {
  const workflow = read('.github/workflows/syntax-check.yml');
  assert.match(workflow, /node-version: \['22', '24'\]/);
  assert.match(workflow, /run: npm run check/);
  assert.match(workflow, /run: npm test/);
});
