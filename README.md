# 剧情推进助手 (Choice Helper) — SillyTavern 扩展 · v2.0.0

仓库：`https://github.com/u1ra/ST-ChoiceHelper`

## 1. 项目简介

一个给 **SillyTavern（酒馆）** 用的轻量前端扩展：AI 每回复完，你可以**手动或自动**让它分析最新剧情、总结当前局势，并生成几条**带风格标签、可直接点击**的行动选项，点击后填入酒馆输入框或直接发送，帮你推进剧情。

- 零构建、零外部依赖、纯原生 JavaScript + 原生 CSS。
- 默认“纯净上下文”：只发送最近几条清洗后的聊天，不注入整张角色卡/世界书，不改主剧情 Prompt、不改主模型配置、不往聊天里插入助手内容。
- 兼容 SillyTavern **1.12+**（含内部 API 兼容适配层）。

## 2. 核心功能

- **总结 + 选项**：总结最新 AI 回复，生成 2–6 个带风格标签的行动选项（默认 4）。
- **双 API 模式**：① 跟随酒馆主 API；② 自定义 OpenAI 兼容 API（自填 URL/Key/模型，可自动拉模型列表）。
- **Quick Hint（本轮走向微调）**：临时输入“这轮想怎么走”，只影响本轮，不写配置、不动角色卡。
- **深度文本清洗**：移除 `<think>/<thinking>/<thought>`（含未闭合）、`<details>/<status>`、`<script>/<style>`、Markdown 代码块、宏、HTML、控制字符；避免思维链污染。
- **首尾智能截断**：超长 AI 回复优先保留**结尾**剧情（不再像旧版只留开头）。
- **主角身份对齐**：用 `name1` 作为玩家主角、`name2` 作为 AI 角色，选项统一第一人称、不替 NPC 决定、不预设成功。
- **强鲁棒解析**：多级 JSON 解析、平衡括号提取、旧格式兼容、去重、编号 bug 修复、非法输出明确报错。
- **请求可取消**：自定义 API 真中断（AbortController）；主 API 逻辑取消（不停止主剧情、不无限并发）。
- **状态隔离**：绑定 message + swipe 的缓存，切聊天 / 切 Swipe / 编辑消息 / 并发请求都不会串台。
- **可拖拽悬浮球 / Quick Hint / 取消按钮 / 草稿保护 / 明暗主题 / 移动端**。

## 3. 安装方法

**方式 A：Git 一键安装（推荐）**
酒馆 **扩展（Extensions）→ 安装扩展程序（Install Extension）→ 填 `https://github.com/u1ra/ST-ChoiceHelper` → 安装 → 刷新页面**。
装好后：聊天界面右下角出现 **🎭**；「扩展程序」列表里出现 **剧情推进助手 (Choice Helper) v2**（可展开、内含“打开面板”按钮）。

**方式 B：本地放入**
把整个文件夹放到 `public/scripts/extensions/third-party/ST-ChoiceHelper`，刷新页面。

> 安装后**刷新**即可加载，无需重启服务。若看不到 🎭，`Ctrl+F5` 硬刷新并看控制台是否出现 `[剧情助手] 已加载 v2.0.0`。

## 4. Docker 安装与持久化

Docker 里「安装扩展程序」是由容器内后端 `git clone` 到 `public/scripts/extensions/third-party/ST-ChoiceHelper`。

```powershell
# 手动放入（docker cp 方式）
docker cp "路径\ST-ChoiceHelper" <容器名>:/home/node/app/public/scripts/extensions/third-party/ST-ChoiceHelper
```

**持久化（容器重建不丢）**：给第三方扩展目录加 bind mount（先把镜像里已有扩展导出，避免顶掉酒馆助手/提示词模板）：

```yaml
volumes:
  - ./extensions:/home/node/app/public/scripts/extensions/third-party
```

更新已装版本：
```powershell
docker exec -it <容器名> sh -c "cd /home/node/app/public/scripts/extensions/third-party/ST-ChoiceHelper && git pull"
```

## 5. 主 API 与自定义 API 配置

🎭 → **⚙ 设置 → 分析用 API**：

- **跟随主 API（默认）**：走你酒馆当前连接的主模型（优先 `generateRaw` 纯净补全，失败降级 `generateQuietPrompt`）。
- **自定义 API**：自填
  - **接口地址**（OpenAI 兼容，填到 `/v1`）：如 `https://api.deepseek.com/v1`、`https://dashscope.aliyuncs.com/compatible-mode/v1`、`https://api.siliconflow.cn/v1`、`https://openrouter.ai/api/v1`、`https://api.openai.com/v1`。
  - **API Key**（只存本机浏览器）。
  - **模型**：点 **「获取模型」** 自动请求 `{地址}/models` 生成下拉；也可手动输入。
  - 进阶：**最大输出 Tokens**（默认 2000）、**温度**（留空=不发送）、**请求超时**（默认 60s）。

请求走 `POST {地址}/chat/completions`，**不改变酒馆主剧情模型**。DeepSeek/OpenAI/OpenRouter/SiliconFlow/通义等主流服务允许浏览器跨域；不支持跨域(CORS)的自建接口会报网络错误。

## 6. Quick Hint 使用说明

主面板底部“💡 本轮走向提示”输入框（`#ch_quick_hint`），右侧 `✕` 清空，**Enter 直接生成**。

- 例：`委婉拒绝`、`主动发起战斗`、`优先调查线索`、`保持冷静不要暴露身份`。
- 优先级高于默认风格分配，但**不覆盖已发生的剧情事实**；只对本轮生效，不写长期配置、不改角色卡。
- 切换聊天自动清空；也可手动清空。

## 7. 风格标签说明

每个选项 = 序号 + **风格标签**（如 `[谨慎试探]`）+ 具体行动正文。标签是 2–6 字的“行动风格”，会根据剧情动态分配（谨慎试探 / 大胆破局 / 社交交涉 / 探索调查 / 迂回策略 / 幽默互动 …），不机械固定。整张卡片可点击。

## 8. 自动生成说明

设置里开启 **自动模式** 后：AI 回复结束（`GENERATION_ENDED` / `CHARACTER_MESSAGE_RENDERED`）会**防抖 + 去重**地自动生成选项。

触发条件：自动模式开、聊天有效、最新是 AI 消息且有正文、当前 Swipe 无有效缓存、无进行中/已失效请求。不会因为打开历史聊天就对全部旧消息重跑，也不会被扩展自身请求反复触发。

## 9. Swipe 缓存恢复说明

结果按 **消息 + Swipe** 绑定缓存：

- 写入 `msg.swipe_info[swipeId].extra.choice_helper`（新版本），并同步 `msg.extra.choice_helper` 和聊天级 `chatMetadata` 兼容索引（旧版本兜底）。
- 只写自己的命名空间 `choice_helper`，不覆盖其他扩展的 `extra`。
- 打开面板 / 刷新 / 切聊天 / 切 Swipe 时，**仅按 swipeId + 消息内容指纹**校验并恢复缓存；消息被编辑则缓存自动失效。
- 被动恢复**不校验 Quick Hint**，所以生成后清空 Hint 或重开面板不会误判失效；主动点“重新生成”才用最新上下文与 Hint 重新请求。

## 10. 悬浮球拖拽说明

右下角 🎭 支持鼠标与触摸拖拽（Pointer Events）：

- 移动 < 5px 视为点击（开/关面板），≥ 5px 视为拖拽。
- 实时跟手、不超出视口、窗口缩放/横竖屏自动收敛。
- 位置保存到 `settings.fabPos = { right, bottom }`；面板会跟随悬浮球位置并避免超出屏幕。

## 11. 请求取消与超时说明

- 生成中主按钮变 **⏹ 取消生成**（红色危险样式），点击立即恢复可操作状态。
- **自定义 API**：用 `AbortController` 真正中断 Fetch；默认 60s 超时；超时/主动取消分别提示。
- **主 API**：部分版本 `generateRaw/generateQuietPrompt` 不支持外部中断——采用**逻辑取消**：请求标记作废、立即恢复 UI、旧结果返回后静默丢弃；**不会调用酒馆全局停止生成**，不影响主剧情。为避免遗留请求无限并发，使用单飞锁 + 2 秒冷却 + 遗留上限保护。

## 12. 设置项目说明

| 设置 | 说明 |
|---|---|
| 分析用 API | 跟随主 API / 自定义 API（URL、Key、模型、最大 Tokens、温度、超时） |
| 记住 Key（关=仅本会话） | 开=localStorage 持久；关=sessionStorage，关浏览器即清 |
| 选项数量 | 2–6，默认 4 |
| 上下文消息数 | 1–12，默认 4 |
| 单条截断字符 | 默认 1600，超长保留首尾 |
| 保留 details/status 正文 | 默认移除整块；勾选则只去标签保留正文 |
| 点击后自动发送 | 输入框已有草稿时不自动发送 |
| 追加模式 | 有草稿时追加而非覆盖 |
| 自动模式 | AI 回复后自动生成（防抖去重） |
| 显示总结 | 是否显示顶部 📌 总结 |
| 额外风格要求 | 自由填写 |

所有设置实时保存；数字项做了范围钳制。

## 13. SillyTavern 版本兼容说明

- 目标 **1.12+**。通过 `globalThis.SillyTavern.getContext()` 获取上下文。
- `generateRaw`：优先对象参数 `{prompt, systemPrompt, responseLength}`；捕获签名错误后回退位置参数（早期 1.12.0）。
- `generateQuietPrompt`：优先对象参数，签名错误回退位置参数 `(prompt,false,true)`。
- 保存：优先 `saveChatConditional()`，其次 `saveChat()`，均带异常处理。
- 事件名从 `ctx.eventTypes || ctx.event_types` 读取并做存在性检查，缺失则跳过。
- 若既无 `generateRaw` 也无 `generateQuietPrompt`，明确提示不可用，不静默当成功。

## 14. 隐私与 API Key 安全说明

- 自定义 Key 仅保存在**本机浏览器**（localStorage 或 sessionStorage），不上传到任何第三方服务器，只作为请求头发给你填写的那个 API 地址。
- 不在控制台日志、错误提示、聊天缓存或生成 Prompt 中出现 Key。
- **注意**：浏览器 `localStorage/sessionStorage` 不是加密凭据库，同源脚本可能读取。敏感场景建议用“仅本会话保存”，或改用“跟随主 API + 酒馆自带的连接配置”。

## 15. 常见问题

- **看不到 🎭**：没装成功/路径不对/未硬刷新。看 `docker exec <容器> ls public/scripts/extensions/third-party/ST-ChoiceHelper`，或控制台 `[剧情助手] 已加载 v2.0.0`。
- **下拉/选项看不清**：已改用主题变量；若仍异常多为浏览器原生 `<select>` 渲染，硬刷新重试。
- **获取模型失败**：接口可能不实现 `/models`，直接手动填模型名即可；或跨域被拦。
- **生成失败/超时**：换模型/检查地址或 Key/调大超时；主 API 侧看酒馆连接是否正常。
- **切 Swipe 后没选项**：该 Swipe 尚无缓存，点“生成选项”；旧 Swipe 的选项不会串过来。
- **自动模式太吵/费 token**：关闭自动模式，改手动点 🎭。

## 16. v2.0.0 更新日志

- **重构**：单文件内按职责拆分为配置 / 兼容层 / 清洗 / Prompt / 客户端 / 请求管理 / 解析 / 缓存 / 事件 / UI 模块。
- **新增**：Quick Hint；风格标签；取消生成（自定义真中断 + 主 API 逻辑取消）；消息+Swipe 级缓存与指纹校验；生命周期事件同步与自动模式去重；可拖拽悬浮球；草稿保护（追加/覆盖）；首尾智能截断；深度文本清洗（思维链/未闭合/敏感块）；主角姓名对齐；强鲁棒多级解析；请求并发/竞争控制。
- **改进**：区分多种空/错误状态；设置实时保存与范围校验；明暗主题与移动端安全区；API Key 本地化且不入日志/缓存。
- **兼容**：`generateRaw/generateQuietPrompt/saveChat` 多版本适配与事件名兜底。
- **迁移**：自动读取 v1 旧配置（字段基本一致），保留 API 地址/模型/选项数量/自动模式/自动发送/自定义风格等。
