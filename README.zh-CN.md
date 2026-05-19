> Languages: [English](README.md) · **简体中文**

# YouTube 双语字幕（DeepSeek / Google 翻译）

一个油猴（Tampermonkey）脚本，**拦截 YouTube 自己的字幕请求**，预先批量翻译成中文，按时间戳叠加在视频上，显示成上中下英的双语字幕。

> **不依赖 YouTube 字幕扩展插件，不依赖任何外部服务器，所有翻译直接调用 DeepSeek 或 Google API。**

## 特点

- **拦截原生字幕**：直接劫持 YouTube `/api/timedtext` 请求，拿到官方字幕原文，不再去解析 DOM
- **智能切分**：跨 event 累积，**只在标点处切**（逗号、句号、问号、感叹号），不会把一句话切到一半
- **双引擎**：默认 DeepSeek（质量高、口语化、保留专有名词），也可一键切换 Google 翻译（不要 API Key，速度快）
- **本地缓存**：每个视频翻译一次，下次直接读缓存，秒出字幕
- **零中间商**：脚本和 API 直连，不经任何中间服务器

## 安装

### 1. 安装油猴

如果还没装，挑一个浏览器扩展装上：

- Chrome / Edge / Brave：[Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- Firefox：[Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) 或 [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/)
- Safari：[Tampermonkey](https://apps.apple.com/app/tampermonkey/id1482490089)

### 2. 安装脚本

把仓库里的 `youtube-bilingual-subs.user.js` 文件内容复制到油猴里：

1. 在 GitHub 上点 `youtube-bilingual-subs.user.js` → 右上角 **Raw**
2. 复制全部内容
3. 点浏览器右上角油猴图标 → 添加新脚本（或"管理面板" → "+"）
4. 把默认模板全选删掉，粘贴脚本内容，按 `Ctrl+S`（Mac 是 `Cmd+S`）保存

或者更简单：在 GitHub 上点 Raw 后，油猴一般会自动弹出安装对话框，点"安装"即可。

## 配置

### 拿 DeepSeek API Key（推荐）

DeepSeek 翻译质量明显比 Google 好，价格也很便宜（输入约 ¥1 / 百万 tokens）。

1. 打开 [platform.deepseek.com](https://platform.deepseek.com/) 注册
2. 充值 10 元就能用很久
3. 左侧 **API Keys** → **创建 API Key** → 复制（`sk-` 开头）

### 把 Key 填进脚本

1. 打开任意一个 YouTube 视频页面
2. 点浏览器右上角油猴图标
3. 在 "YouTube 双语字幕" 的下拉菜单里，点 **设置 DeepSeek API Key**
4. 把 `sk-xxx` 粘进弹窗 → 确定
5. 刷新页面

### （可选）切换到 Google 翻译

不想付费？切到 Google 也能用，只是质量差点：

1. 油猴菜单 → **切换引擎 (当前: deepseek)** → 确定
2. 刷新页面

## 使用

1. 打开任意 YouTube 视频
2. **必须点开 YouTube 自带的 CC 字幕按钮**——脚本要靠 YouTube 自己发字幕请求才能拦截
3. 顶部会出现绿色调试条："请打开 CC 按钮，等待拦截字幕…"
4. 拦截到字幕后，先显示英文（让你能立刻看到字幕），同时后台批量翻译
5. 翻译完成后，字幕自动变成中英对照
6. 调试条几秒后变淡

**字幕样式**：中文在上（白色加粗），英文在下（小一号、稍透明），都带黑色描边阴影，深浅画面都能看清。

## 油猴菜单（点扩展图标 → 脚本名下拉）

| 菜单 | 作用 |
| --- | --- |
| 设置 DeepSeek API Key | 弹窗填 / 改 API Key |
| 切换引擎 (当前: xxx) | 在 deepseek 和 google 间切换 |
| 清除当前视频缓存 | **改了脚本逻辑后必点**，否则一直读旧的切分结果 |
| 开关调试条 | 隐藏 / 显示顶部调试信息 |

## 字幕切分规则（v0.9.1）

| 触发条件 | 行为 |
| --- | --- |
| 单词末尾是 `. ! ? 。 ！ ？` 或 `, ， ; ； : ：` | **立即切**，作为一条字幕 |
| 累积超过 10 秒还没遇到标点 | 兜底切，防止卡住 |
| event 边界 | **不切**（跨 event 累积，避免一句话被强行掐断） |

想调整每条字幕的长度，改脚本里这一行：

```javascript
const MAX_CHUNK_MS = 10000;  // 兜底时长，单位毫秒
```

- 改小（如 7000）→ 字幕更短、更频繁
- 改大（如 15000）→ 字幕更长、停留时间更久

## 常见问题

**Q: 调试条显示"30 秒内未拦截到字幕"**
A: 你忘了点 YouTube 自己的 CC 字幕按钮。脚本是劫持 YouTube 的字幕请求工作的，你不开 CC，YouTube 根本不发字幕请求。

**Q: 调试条说"解析后字幕为空"**
A: 这个视频可能只有非常特殊的字幕格式。把脚本顶部 `console.log` 看一下控制台报错，提 issue。

**Q: 翻译质量不行 / 翻译失败**
A: 检查 DeepSeek 余额；或者切到 Google 引擎试试。

**Q: 改了脚本但好像没生效**
A: 油猴里 Ctrl+S 保存 → **关 YouTube 页面**重新打开（不是刷新）→ 油猴菜单点"清除当前视频缓存"。

**Q: 字幕在视频上的位置不对**
A: 改脚本里 `#ytdsk-overlay` 的 `bottom: 12%`，调大会更靠上。

**Q: 不想看到顶部那条绿色调试条**
A: 油猴菜单 → 开关调试条；或者改脚本顶部 `debugVisible: false`。

**Q: 一个视频翻译完用了多少钱？**
A: 一个 10 分钟视频大约 2000-3000 tokens 输入 + 等量输出，DeepSeek 全程不到 ¥0.01。

## 隐私

- 脚本所有数据都存在本地油猴存储（GM_setValue），不上传任何服务器
- 翻译请求**直连**官方 API（api.deepseek.com / translate.googleapis.com），没有中间代理
- API Key 只存你本地浏览器，源码透明

## 更新日志

- **0.9.1** 重写字幕解析的去重逻辑，修复"YouTube CC 显示但插件叠加层漏句"的问题：
  - 识别 json3 的 `aAppend` 滚动字幕追加帧（之前会被重复计入累积器，把内容搅成一团）
  - 区分三种重叠：完全重复 / 前缀扩展型 rolling / 后缀重发型 rolling，分别合并或丢弃，绝不丢弃"内容真正不同"的事件（v0.9.0 的"lazy dog"会被误杀的 bug 根因）
  - 渲染端二分查找改成"最近开始 + 跨小间隙保留 1.5s"，避免 cue 间小空隙时字幕条空白闪烁
- **0.9.0** 重写字幕解析：跨 event 累积、只在标点处切、10s 兜底；修复 ASR 字幕被 event 边界强行切断的问题（如 "I also teach around" 这种半句独立成行）
- **0.8.1** 修复 off-by-one：注释说"第 3 个逗号才切"，代码实际是第 2 个就切
- **0.8.0** 拦截模式重构

## 许可

MIT
