# 剧情推进助手 (Choice Helper) — 酒馆第三方扩展

一个给 **SillyTavern（酒馆）** 用的小扩展：点一下，自动**总结 AI 最新一轮发言**，并生成几个**可直接点击的行动选项**，点击即填入输入框（可选自动发送），帮你把剧情往前推。

- 纯前端、无构建、无第三方依赖，一个文件夹丢进去就能用。
- 走 `generateRaw` **纯净补全**：只读最近几条消息，**不注入角色卡/世界书**，不污染主上下文、不干扰存档。
- 兼容 SillyTavern **1.12+**（Docker 部署同款前端即可）。
- 自动适配酒馆明/暗主题。

---

## 一键安装（Git 仓库，推荐）

仓库地址：

```
https://github.com/u1ra/ST-ChoiceHelper
```

酒馆内操作：**扩展（Extensions）→ 安装扩展程序（Install Extension）→ 粘贴上面的仓库地址 → 安装 → 刷新页面**。
右下角出现 **🎭** 即成功。

> 说明：`安装扩展程序` 是由酒馆后端执行 `git clone`，装到 `public/scripts/extensions/third-party/ST-ChoiceHelper`。
> Docker 部署下该目录默认不持久化，容器重建会丢；想长期保留请参考下面「方式 B」做 bind mount。

---

## 一、安装（Docker 版酒馆）

> 扩展是"静态前端文件"，放进去后**浏览器刷新**即可，不用重启容器/服务。
> 先记住容器名：`docker ps` 里那一列 `NAMES`。

### 方式 A：最快（docker cp，立即生效，容器重建后会丢）

```powershell
# 把整个文件夹复制进容器的第三方扩展目录
docker cp "E:\DeepSeekProject\MDZS\ST-ChoiceHelper" <容器名>:/home/node/app/public/scripts/extensions/third-party/ST-ChoiceHelper
```

- 官方镜像一般工作目录是 `/home/node/app`；若报路径不存在，用下面命令确认正确路径：
  ```powershell
  docker exec -it <容器名> sh -c "pwd; ls public/scripts/extensions/third-party"
  ```
  老一些的镜像可能是 `/usr/src/app/...`，把上面命令里的 `/home/node/app` 换成对应前缀即可。
- 复制完 → 浏览器 `Ctrl+F5` 硬刷新 → 右下角出现 **🎭** 悬浮按钮即成功。

### 方式 B：持久化（推荐，容器重建不丢）

用 bind mount 把「第三方扩展目录」映射到宿主机。**注意：直接挂空目录会把镜像里已有的扩展（酒馆助手、提示词模板等）挡掉，务必先把现有目录导出。**

1. 在 `docker-compose.yml` 同目录建 `extensions` 文件夹。
2. 先把容器里现有的第三方扩展导出到宿主机（防止被覆盖）：
   ```powershell
   docker cp <容器名>:/home/node/app/public/scripts/extensions/third-party/. ./extensions/
   ```
3. 把本扩展复制进去：
   ```powershell
   Copy-Item -Recurse "E:\DeepSeekProject\MDZS\ST-ChoiceHelper" ".\extensions\ST-ChoiceHelper"
   ```
4. 在 `docker-compose.yml` 对应 service 的 `volumes:` 下加一行（注意缩进）：
   ```yaml
   volumes:
     - ./extensions:/home/node/app/public/scripts/extensions/third-party
   ```
5. 重建：
   ```powershell
   docker compose up -d
   ```
6. 浏览器 `Ctrl+F5` 刷新。

### 方式 C：走 Git（以后想一键更新时用）

把本文件夹推到一个 Git 仓库，然后在酒馆：**扩展（Extensions）→ Install Extension From Git Repo** 填仓库地址即可。

---

## 二、使用

1. 进入任意聊天，AI 回复后，点右下角 **🎭**。
2. 面板里点 **生成选项**：
   - 顶部出现 **📌 一句话总结**（AI 最新这轮发生了什么）。
   - 下方出现 **若干行动选项**，每个都不同风格（谨慎/大胆/社交/探索/搞笑…）。
3. **点选项** → 文本自动填入输入框（默认只填不发，你确认后回车；可在设置里开「自动发送」）。
4. **↻ 重新生成**：不满意就再摇一批；**⚙ 设置**：调选项数量、上下文条数、自动模式等。

### 设置项

| 设置 | 说明 | 默认 |
|---|---|---|
| 选项数量 | 每次生成几个选项（2–6） | 4 |
| 上下文消息数 | 读取最近几条消息用于总结 | 4 |
| 点击后自动发送 | 关：只填入输入框；开：填完直接发送 | 关 |
| 自动模式 | AI 每次回复后自动弹出选项（会多耗 token） | 关 |
| 显示总结 | 是否显示顶部总结 | 开 |
| 额外风格要求 | 自定义口味，如「更腹黑 / 选项短一点」 | 空 |

> 设置保存在本浏览器的 `localStorage`，清缓存/换浏览器会重置。

---

## 三、原理 / 说明

- **总结 + 选项** 走 `generateRaw`：一次独立的小补全，只把你最近几条消息 + 指令发给**你当前配置的 API/模型**，返回严格 JSON。**不写入聊天记录、不动世界书、不进主上下文**。
- 若你的酒馆版本没有 `generateRaw`，会自动降级用 `generateQuietPrompt`。
- 每次点击 ≈ 一次几百 token 的额外请求，几乎不影响主剧情上下文。
- 隐私：发送内容 = 最近几条聊天消息，走的就是你自己配的 API，和正常聊天一致。

---

## 四、常见问题

| 现象 | 处理 |
|---|---|
| 右下角没有 🎭 | 没复制成功 / 路径不对 / 没硬刷新。检查 `docker exec <容器> ls public/scripts/extensions/third-party/ST-ChoiceHelper`，浏览器 `Ctrl+F5`，看控制台是否出现 `[剧情助手] 已加载` |
| 点生成报「没有可用的生成接口」 | 酒馆太老或缺 API，确认已选好 API 且能正常聊天；建议 1.12+ |
| 生成失败/超时 | 当前模型/线路不稳，换模型或稍后重试 |
| 选项解析成一坨 / 不整齐 | 换 JSON 能力更强的模型；或把「选项数量」调小；本扩展已有兜底解析 |
| 选项老是重复、没新意 | 调大「上下文消息数」到 6–8，或在「额外风格要求」里写清口味 |
| 自动模式太吵/太费 | 关掉「自动模式」，改手动点 🎭 |

---

## 五、目录结构

```
ST-ChoiceHelper/
├── manifest.json   扩展清单（酒馆据此加载）
├── index.js        全部逻辑（UI + 生成 + 解析 + 插入）
├── style.css       样式（跟随主题变量）
└── README.md       本说明
```
