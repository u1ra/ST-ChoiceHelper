/*
 * 剧情推进助手 (Choice Helper) — SillyTavern 第三方扩展
 * ==================================================================
 * 版本：2.0.0
 * 作者：LittleCodeSauce
 *
 * 功能：在 AI 回复后，自动或手动分析最新剧情，总结当前局势，
 *       结合玩家主角身份 / 历史上下文 / 本轮意图，生成带“风格标签”的
 *       可执行行动选项。点击选项可填入酒馆输入框或直接发送。
 *
 * 架构（单文件 IIFE，零构建、零外部依赖）：
 *   §0 常量与工具
 *   §1 配置管理（含 v1 迁移、校验、持久化策略）
 *   §2 SillyTavern API 兼容层（generateRaw / generateQuietPrompt / saveChat / 事件）
 *   §3 文本清洗与智能首尾截断
 *   §4 上下文提取（buildExcerpt）与 Prompt 构建
 *   §5 AI 请求客户端（主 API / 自定义 OpenAI 兼容 API）
 *   §6 请求生命周期与并发/取消管理
 *   §7 结果解析与校验（parseResult / normalizeChoices）
 *   §8 消息/Swipe 级缓存（swipe_info / msg.extra / chatMetadata 兼容）
 *   §9 酒馆生命周期事件同步与自动模式
 *   §10 UI（可拖拽悬浮球 / Quick Hint / 风格标签 / 取消按钮 / 草稿保护 / 设置）
 *   §11 初始化与错误恢复
 * ==================================================================
 */

(function () {
    'use strict';

    /* ================================================================
     * §0 常量与工具
     * ================================================================ */
    const TAG = '[剧情助手]';
    const SETTINGS_KEY = 'choice_helper_settings_v2';
    const LEGACY_KEY = 'choice_helper_settings_v1';
    const UI_ID = 'ch_root';
    const CACHE_NS = 'choice_helper';
    const CACHE_SCHEMA_VERSION = 2;
    const SELF_GEN_GUARD_MS = 4000;   // 自身生成后这段时间内不触发自动模式
    const MAIN_COOLDOWN_MS = 2000;    // 主 API 逻辑取消后的防抖冷却
    const MAX_PENDING_MAIN = 3;       // 允许并行遗留的主 API 请求上限

    const W = (typeof window !== 'undefined') ? window : null;

    const DEFAULTS = {
        // 生成
        choiceCount: 4,            // 2-6
        contextMessages: 4,        // 1-12
        maxCharsPerMsg: 1600,      // 单条消息截断上限（首尾保留）
        headRatio: 0.3,            // 首部保留比例，其余给尾部
        keepDetailsStatus: false,  // true=保留 <details>/<status> 正文（仅去标签）
        showSummary: true,
        extraStyle: '',
        // 交互
        autoSend: false,
        autoMode: false,
        appendMode: true,          // 输入框已有草稿时追加而非覆盖
        // API
        apiMode: 'main',           // 'main' | 'custom'
        customBaseUrl: '',
        customApiKey: '',
        customModel: '',
        maxOutputTokens: 2000,
        temperature: '',           // '' = 不发送 temperature
        requestTimeout: 60,        // 秒
        persistKey: true,          // true=localStorage 持久；false=sessionStorage 仅本会话
        // 界面
        fabPos: { right: 18, bottom: 120 },
    };

    let settings = DEFAULTS;
    let ui = null;

    // 运行时状态（不持久化）
    let quickHint = '';
    let busy = false;
    let selfGenerating = false;
    let selfGenUntil = 0;
    let currentResult = null;       // 当前展示的结果缓存
    let autoTimer = null;
    let lastHandledAiIndex = -1;    // 自动模式去重

    // 请求管理状态
    let reqSeq = 0;
    let current = null;             // { id, cancelled, controller, snapshot, reason }
    let pendingMain = 0;
    let cooldownUntil = 0;

    function log() {
        try { console.log(TAG, ...arguments); } catch (_) {}
    }
    function now() { return Date.now(); }
    function clamp(n, lo, hi) { n = Number(n); if (!isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, n)); }
    function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function str(v) { return v == null ? '' : String(v); }

    function makeErr(code, message) {
        const e = new Error(message || code);
        e.code = code;
        return e;
    }
    function errMsg(e) {
        if (!e) return '未知错误';
        if (e.cause && e.cause.message) return str(e.cause.message);
        return str(e.message || e);
    }

    // 简单字符串指纹（djb2 + 长度）
    function hashStr(s) {
        s = str(s);
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36) + ':' + s.length;
    }

    function vw() { return (W && W.innerWidth) || (document.documentElement && document.documentElement.clientWidth) || 1024; }
    function vh() { return (W && W.innerHeight) || (document.documentElement && document.documentElement.clientHeight) || 768; }

    function toast(msg) {
        let box = document.getElementById('ch_toast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'ch_toast';
            document.body.appendChild(box);
        }
        box.textContent = str(msg);
        box.classList.add('ch-toast-show');
        clearTimeout(box._t);
        box._t = setTimeout(function () { box.classList.remove('ch-toast-show'); }, 3200);
    }

    /* ================================================================
     * §1 配置管理
     * ================================================================ */
    function sanitizeSettings(o) {
        o = isObj(o) ? o : {};
        const s = Object.assign({}, DEFAULTS, o);
        s.choiceCount = clamp(s.choiceCount, 2, 6);
        s.contextMessages = clamp(s.contextMessages, 1, 12);
        s.maxCharsPerMsg = clamp(s.maxCharsPerMsg, 300, 8000);
        s.headRatio = clamp(s.headRatio, 0.1, 0.6);
        s.maxOutputTokens = clamp(s.maxOutputTokens, 64, 32000);
        s.requestTimeout = clamp(s.requestTimeout, 5, 300);
        s.keepDetailsStatus = !!s.keepDetailsStatus;
        s.showSummary = s.showSummary !== false;
        s.autoSend = !!s.autoSend;
        s.autoMode = !!s.autoMode;
        s.appendMode = s.appendMode !== false;
        s.persistKey = s.persistKey !== false;
        s.apiMode = s.apiMode === 'custom' ? 'custom' : 'main';
        s.customBaseUrl = str(s.customBaseUrl);
        s.customApiKey = str(s.customApiKey);
        s.customModel = str(s.customModel);
        s.extraStyle = str(s.extraStyle);
        s.temperature = (s.temperature === '' || s.temperature == null) ? '' : String(s.temperature);
        if (!isObj(s.fabPos)) s.fabPos = { right: 18, bottom: 120 };
        s.fabPos = {
            right: isFinite(Number(s.fabPos.right)) ? Number(s.fabPos.right) : 18,
            bottom: isFinite(Number(s.fabPos.bottom)) ? Number(s.fabPos.bottom) : 120,
        };
        return s;
    }

    function loadSettings() {
        let raw = null;
        try { raw = localStorage.getItem(SETTINGS_KEY); } catch (_) {}
        if (!raw) { try { raw = sessionStorage.getItem(SETTINGS_KEY); } catch (_) {} }
        if (!raw) {
            try {
                const legacy = localStorage.getItem(LEGACY_KEY);
                if (legacy) raw = legacy; // v1 迁移（字段名基本一致）
            } catch (_) {}
        }
        let obj = {};
        if (raw) { try { obj = JSON.parse(raw); } catch (_) { obj = {}; } }
        return sanitizeSettings(obj);
    }

    function saveSettings() {
        try {
            const target = settings.persistKey ? localStorage : sessionStorage;
            const other = settings.persistKey ? sessionStorage : localStorage;
            target.setItem(SETTINGS_KEY, JSON.stringify(settings));
            try { other.removeItem(SETTINGS_KEY); } catch (_) {}
        } catch (_) {}
    }

    /* ================================================================
     * §2 SillyTavern API 兼容层
     * ================================================================ */
    function getCtxSafe() {
        try {
            return (globalThis.SillyTavern && globalThis.SillyTavern.getContext)
                ? globalThis.SillyTavern.getContext()
                : null;
        } catch (_) { return null; }
    }
    function getCtx() {
        const c = getCtxSafe();
        if (!c) throw makeErr('NO_CONTEXT', '无法获取酒馆上下文（getContext 不可用），请确认 SillyTavern 1.12+');
        return c;
    }
    function ctxEvents(c) { return (c && (c.eventTypes || c.event_types)) || {}; }
    function ctxChatId(c) {
        if (!c) return '';
        try { if (c.chatId) return str(c.chatId); } catch (_) {}
        try { if (typeof c.getCurrentChatId === 'function') return str(c.getCurrentChatId()); } catch (_) {}
        return '';
    }

    function isSignatureError(e) {
        const m = str(e && e.message).toLowerCase();
        return /argument|parameter|positional|signature|quietprompt|is not a function|undefined is not|cannot read/.test(m);
    }

    // generateRaw：优先对象参数；捕获签名错误后回退位置参数（早期 1.12.0）
    async function callRawFn(fn, prompt, responseLength) {
        try {
            return await fn({ prompt: prompt, systemPrompt: SYSTEM_PROMPT, responseLength: responseLength });
        } catch (e) {
            if (isSignatureError(e)) {
                try { return await fn(prompt, SYSTEM_PROMPT, responseLength); } catch (_) { throw e; }
            }
            throw e;
        }
    }
    // generateQuietPrompt：对象参数优先，签名错误回退位置参数
    async function callQuietFn(fn, prompt, responseLength) {
        try {
            return await fn({ quietPrompt: prompt, quietName: '剧情助手', skipWIAN: true, responseLength: responseLength });
        } catch (e) {
            if (isSignatureError(e)) {
                try { return await fn(prompt, false, true); } catch (_) { throw e; }
            }
            throw e;
        }
    }

    async function saveChatSafe() {
        const c = getCtxSafe();
        if (!c) return false;
        try {
            if (typeof c.saveChatConditional === 'function') { await c.saveChatConditional(); return true; }
            if (typeof c.saveChat === 'function') { await c.saveChat(); return true; }
        } catch (e) { log('保存聊天失败', e); return false; }
        return false;
    }

    /* ================================================================
     * §3 文本清洗与智能首尾截断
     * ================================================================ */
    const THINK_TAGS = ['think', 'thinking', 'thought', 'reasoning', 'analysis'];
    const BLOCK_TAGS = ['details', 'status', 'statusbar', 'stat_block'];
    const HARD_BLOCK_TAGS = ['script', 'style', 'template', 'if', 'updatevariable', 'update_variable'];

    function stripPairedBlock(t, tag) {
        const re = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi');
        return t.replace(re, '\n');
    }
    function stripUnclosedBlock(t, tag) {
        // 未闭合：从第一个开标签删到结尾（思维链/脚本通常是尾部推理）
        const re = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*$', 'i');
        return t.replace(re, '\n');
    }
    function stripTagsOnly(t, tag) {
        const open = new RegExp('<' + tag + '\\b[^>]*>', 'gi');
        const close = new RegExp('<\\/' + tag + '\\s*>', 'gi');
        return t.replace(close, ' ').replace(open, ' ');
    }

    /**
     * 深度清洗 + 首尾智能截断
     * @param {string} raw
     * @param {{maxChars?:number, headRatio?:number, keepDetailsStatus?:boolean}} [opts]
     */
    function cleanText(raw, opts) {
        if (raw == null) return '';
        opts = opts || {};
        const maxChars = isFinite(opts.maxChars) ? Number(opts.maxChars) : settings.maxCharsPerMsg;
        const headRatio = isFinite(opts.headRatio) ? Number(opts.headRatio) : settings.headRatio;
        const keepDS = (opts.keepDetailsStatus != null) ? !!opts.keepDetailsStatus : settings.keepDetailsStatus;

        let t = String(raw);

        // 1) 思维链：成对 + 未闭合，全部移除正文（绝不保留推理）
        for (const tag of THINK_TAGS) {
            t = stripPairedBlock(t, tag);
            t = stripUnclosedBlock(t, tag);
        }
        // 2) 脚本/危险块：整块移除
        for (const tag of HARD_BLOCK_TAGS) {
            t = stripPairedBlock(t, tag);
        }
        // 3) details/status：默认整块移除；keepDS 时仅去标签保留正文
        for (const tag of BLOCK_TAGS) {
            if (keepDS) t = stripTagsOnly(t, tag);
            else { t = stripPairedBlock(t, tag); }
        }
        // 4) Markdown 代码块
        t = t.replace(/```[\s\S]*?```/g, ' ');
        // 5) 酒馆宏 {{...}}
        t = t.replace(/\{\{[\s\S]*?\}\}/g, ' ');
        // 6) 残余 HTML/XML 标签
        t = t.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
        // 7) 控制字符（保留 \n \t）
        t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        // 8) 规整空白
        t = t.replace(/[ \t\u00a0]+/g, ' ');
        t = t.replace(/\n[ \t]+/g, '\n');
        t = t.replace(/\n{3,}/g, '\n\n').trim();

        // 9) 首尾智能截断
        if (isFinite(maxChars) && maxChars > 0 && t.length > maxChars) {
            t = smartTruncate(t, maxChars, headRatio);
        }
        return t;
    }

    function isLowSurrogate(code) { return code >= 0xDC00 && code <= 0xDFFF; }
    function safeCutStart(s, idx) {
        // 避免从代理对中间切
        if (idx > 0 && idx < s.length && isLowSurrogate(s.charCodeAt(idx))) return idx + 1;
        return idx;
    }

    function smartTruncate(t, max, headRatio) {
        if (t.length <= max) return t;
        const marker = '…[中间省略]…';
        const budget = Math.max(40, max - marker.length);
        const headLen = Math.max(10, Math.floor(budget * headRatio));
        const tailLen = Math.max(10, budget - headLen);

        // 头部：尽量在句末标点处切断
        let head = t.slice(0, headLen);
        const hBoundary = Math.max(
            head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
            head.lastIndexOf('!'), head.lastIndexOf('?'), head.lastIndexOf('.'), head.lastIndexOf('\n')
        );
        if (hBoundary > headLen * 0.6) head = head.slice(0, hBoundary + 1);

        // 尾部：优先保留结尾，尽量从句首开始
        let tail = t.slice(t.length - tailLen);
        const startScan = Math.min(30, tail.length - 1);
        for (let i = 0; i <= startScan; i++) {
            const ch = tail[i];
            if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '.' || ch === '\n') {
                tail = tail.slice(i + 1);
                break;
            }
        }
        // 代理对安全
        const startIdx = safeCutStart(t, t.length - tail.length);
        tail = t.slice(startIdx);

        return head.trim() + marker + tail.trim();
    }

    /* ================================================================
     * §4 上下文提取与 Prompt 构建
     * ================================================================ */
    function getLastAiIndex(chat) {
        if (!Array.isArray(chat)) return -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            if (!m.is_user) return i;
        }
        return -1;
    }
    function getSwipeId(msg) {
        if (!msg) return 0;
        if (Number.isInteger(msg.swipe_id)) return msg.swipe_id;
        if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id)) return msg.swipe_id;
        return 0;
    }
    function msgFingerprint(msg) {
        if (!msg) return '';
        return hashStr(cleanText(msg.mes != null ? msg.mes : msg.content, { maxChars: 1e9 }));
    }

    function buildExcerpt(c) {
        const chat = Array.isArray(c.chat) ? c.chat : [];
        if (!chat.length) return { ok: false, reason: '当前没有聊天内容，请先开始一段对话。' };
        const lastAi = getLastAiIndex(chat);
        if (lastAi < 0) return { ok: false, reason: '还没找到 AI 的发言，先让 AI 回复一次。' };

        const name1 = c.name1 || '玩家';
        const name2 = c.name2 || '';
        const n = clamp(settings.contextMessages, 1, 12);
        const start = Math.max(0, lastAi - n + 1);

        const lines = [];
        let total = 0;
        const budget = settings.maxCharsPerMsg * n;
        // 从最新往前收集，保证最新 AI 结尾一定保留
        for (let i = lastAi; i >= start; i--) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            const text = cleanText(m.mes != null ? m.mes : m.content, { maxChars: settings.maxCharsPerMsg });
            if (!text) continue;
            const who = m.is_user ? (name1 + '（玩家主角）') : (m.name || name2 || 'AI');
            const line = who + '：' + text;
            lines.unshift(line);
            total += line.length;
            if (total > budget && lines.length > 1) {
                // 超预算：优先削减较早消息，但绝不丢弃最新一条
                if (i !== lastAi) { lines.shift(); total -= lines.length ? lines[0].length : 0; }
            }
        }
        if (!lines.length) return { ok: false, reason: '最近的消息没有可总结的文本（可能都是空的）。' };

        const lastMsg = chat[lastAi];
        return {
            ok: true,
            excerpt: lines.join('\n\n'),
            lastAiIndex: lastAi,
            names: { name1: name1, name2: name2 },
            meta: {
                chatId: ctxChatId(c),
                charId: str(c.characterId),
                groupId: str(c.groupId),
                swipeId: getSwipeId(lastMsg),
                msgFingerprint: msgFingerprint(lastMsg),
            },
        };
    }

    const SYSTEM_PROMPT =
        '你是一个中文互动小说 / 跑团的“剧情推进助手”。你只站在玩家一侧提供帮助：' +
        '总结局势、给出可执行的行动建议。你不扮演任何角色、不续写正文、不做冗长心理描写、' +
        '不输出任何标签（如 UpdateVariable、status）或代码块。你的输出必须是一个严格合法的 JSON 对象。';

    function buildPrompt(built, hint) {
        const n = clamp(settings.choiceCount, 2, 6);
        const nm = built.names || {};
        const player = nm.name1 || '玩家';
        const chars = nm.name2 || 'AI 角色';
        const parts = [];
        parts.push('下面是一段互动剧情的最近对话（按时间顺序）：');
        parts.push('-----');
        parts.push(built.excerpt);
        parts.push('-----');
        parts.push('');
        parts.push('说明：对话中“' + player + '（玩家主角）”代表玩家控制的主角；“' + chars + '”等代表 AI 扮演的角色或 NPC。');
        parts.push('');
        parts.push('请完成两件事：');
        parts.push('1) 用 1-2 句中文总结【最新一条 AI 回复】发生了什么：主角当前处境、他人反应、以及最关键的矛盾或机会点。');
        parts.push('2) 给出 ' + n + ' 个玩家接下来【可以直接采取】的行动选项。');
        parts.push('   - 每个选项站在玩家主角视角、使用第一人称、可直接作为玩家回复发送。');
        parts.push('   - 描述具体行动、言语或策略，彼此存在真实策略差异（避免同一意思换措辞）。');
        parts.push('   - 不擅自决定其他角色的反应，不预先宣告行动成功，不替玩家完成尚未发生的剧情，不凭空揭示未发现的信息。');
        parts.push('   - 不重复最新 AI 已经完成的行动，不强制剧情跳跃。');
        parts.push('   - 为每个选项给一个 2-6 字的“风格标签”（如：谨慎试探/大胆破局/社交交涉/探索调查/迂回策略/幽默互动，可按剧情动态调整）。');

        if (hint && String(hint).trim()) {
            parts.push('');
            parts.push('【本轮玩家期望的剧情走向/意图（高优先级）】' + String(hint).trim());
            parts.push('（该意图只影响本轮选项，不得覆盖已经发生的剧情事实。）');
        }
        if (settings.extraStyle && settings.extraStyle.trim()) {
            parts.push('');
            parts.push('【额外风格要求】' + settings.extraStyle.trim());
        }
        parts.push('');
        parts.push('严格只输出一个 JSON 对象，格式如下，不要任何多余文字、不要 Markdown 代码块：');
        parts.push('{"summary":"（一句话总结）","choices":[{"tag":"谨慎试探","text":"（第一人称行动1）"},{"tag":"大胆破局","text":"（第一人称行动2）"}]}');
        return parts.join('\n');
    }

    /* ================================================================
     * §5 AI 请求客户端
     * ================================================================ */
    function isLocalHost(hostname) {
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === '0.0.0.0';
    }
    function normalizeBaseUrl(raw) {
        let b = String(raw || '').trim();
        if (!b) throw makeErr('NO_URL', '请先在设置里填写「接口地址」');
        let u;
        try { u = new URL(b); } catch (_) { throw makeErr('BAD_URL', '接口地址格式不正确'); }
        if (!/^https?:$/.test(u.protocol)) throw makeErr('BAD_SCHEME', '接口地址只支持 http/https');
        if (u.protocol === 'http:' && !isLocalHost(u.hostname)) {
            throw makeErr('INSECURE_URL', '远程接口请使用 https（本机 localhost 可用 http）');
        }
        // 去掉末尾斜杠与可能的 /chat/completions、/models
        let base = b.replace(/\/+$/, '');
        base = base.replace(/\/chat\/completions$/i, '');
        base = base.replace(/\/models$/i, '');
        return base;
    }
    function apiUrl(path) { return normalizeBaseUrl(settings.customBaseUrl) + path; }
    function authHeaders(key) {
        const h = { 'Content-Type': 'application/json' };
        if (key) h['Authorization'] = 'Bearer ' + key;
        return h;
    }
    async function safeText(res) { try { return await res.text(); } catch (_) { return ''; } }

    async function fetchModels(controller, timeoutMs) {
        const key = str(settings.customApiKey).trim();
        const url = apiUrl('/models');
        const ctrl = controller || new AbortController();
        const timer = setTimeout(function () { try { ctrl.abort('timeout'); } catch (_) {} }, timeoutMs || (clamp(settings.requestTimeout, 5, 300) * 1000));
        try {
            const res = await fetch(url, { method: 'GET', headers: key ? { 'Authorization': 'Bearer ' + key } : {}, signal: ctrl.signal });
            if (!res.ok) { const t = await safeText(res); throw makeErr('MODELS_HTTP', '获取模型失败：HTTP ' + res.status + (t ? ' · ' + t.slice(0, 200) : '')); }
            const data = await res.json();
            const arr = Array.isArray(data) ? data : (data.data || data.models || []);
            return (arr || []).map(function (m) { return typeof m === 'string' ? m : (m.id || m.name || m.model); }).filter(Boolean);
        } catch (e) {
            if (e && e.name === 'AbortError') throw makeErr('TIMEOUT', '获取模型超时或已取消');
            if (e instanceof TypeError) throw makeErr('CORS', '请求失败（可能是跨域/CORS 或网络问题）');
            throw e;
        } finally { clearTimeout(timer); }
    }

    async function doFetchChat(url, body, key, signal) {
        return await fetch(url, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body), signal: signal });
    }

    async function customChat(prompt, token, controller) {
        const key = str(settings.customApiKey).trim();
        const model = str(settings.customModel).trim();
        if (!model) throw makeErr('NO_MODEL', '请先选择或填写模型（可点「获取模型」）');
        const url = apiUrl('/chat/completions');
        const maxTok = clamp(settings.maxOutputTokens, 64, 32000);
        const timeoutMs = clamp(settings.requestTimeout, 5, 300) * 1000;

        let timedOut = false;
        const timer = setTimeout(function () { timedOut = true; try { controller.abort('timeout'); } catch (_) {} }, timeoutMs);

        const baseBody = {
            model: model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
            stream: false,
            max_tokens: maxTok,
        };
        const temp = parseFloat(settings.temperature);
        if (!isNaN(temp)) baseBody.temperature = temp;

        try {
            let res = await doFetchChat(url, baseBody, key, controller.signal);
            if (res.status === 400) {
                const txt = await safeText(res);
                if (/max_completion_tokens/i.test(txt)) {
                    const b2 = Object.assign({}, baseBody);
                    delete b2.max_tokens; b2.max_completion_tokens = maxTok;
                    res = await doFetchChat(url, b2, key, controller.signal);
                } else {
                    throw makeErr('HTTP_400', '接口返回 400 · ' + txt.slice(0, 300));
                }
            }
            if (!res.ok) { const t = await safeText(res); throw makeErr('HTTP_' + res.status, '接口返回 HTTP ' + res.status + (t ? ' · ' + t.slice(0, 300) : '')); }

            const data = await res.json();
            const choice = data && data.choices && data.choices[0];
            let content = choice ? (choice.message ? choice.message.content : choice.text) : '';
            if ((content == null || content === '') && choice && choice.message && choice.message.reasoning_content) {
                throw makeErr('REASONING_ONLY', '模型只返回了推理内容、没有最终答复，请换模型或重试');
            }
            return str(content);
        } catch (e) {
            if (timedOut) throw makeErr('TIMEOUT', '请求超时（' + settings.requestTimeout + 's）');
            if (e && e.name === 'AbortError') {
                if (token && token.cancelled) throw makeErr('ABORTED', '已取消');
                throw makeErr('TIMEOUT', '请求已中止');
            }
            if (e instanceof TypeError) throw makeErr('CORS', '请求失败（可能是跨域/CORS、地址错误或网络问题）');
            throw e;
        } finally { clearTimeout(timer); }
    }

    async function callMain(prompt) {
        const c = getCtx();
        const responseLength = clamp(settings.maxOutputTokens, 64, 32000);
        pendingMain++;
        try {
            let mainErr = null;
            if (typeof c.generateRaw === 'function') {
                try { const r = await callRawFn(c.generateRaw.bind(c), prompt, responseLength); return r; }
                catch (e) { mainErr = e; }
            }
            if (typeof c.generateQuietPrompt === 'function') {
                const r = await callQuietFn(c.generateQuietPrompt.bind(c), prompt, responseLength);
                return r;
            }
            // 动态从 script.js 取（同源兜底）
            for (const spec of ['/script.js', '../../../script.js', '../../../../script.js']) {
                try {
                    const m = await import(/* @vite-ignore */ spec);
                    if (typeof m.generateRaw === 'function') { const r = await callRawFn(m.generateRaw, prompt, responseLength); return r; }
                    if (typeof m.generateQuietPrompt === 'function') { const r = await callQuietFn(m.generateQuietPrompt, prompt, responseLength); return r; }
                } catch (_) {}
            }
            throw mainErr || makeErr('NO_API', '当前酒馆版本没有可用的生成接口（generateRaw/generateQuietPrompt 均不可用）');
        } finally { pendingMain--; }
    }

    /* ================================================================
     * §6 请求生命周期与并发/取消管理
     * ================================================================ */
    function makeSnapshot(built, hint) {
        return {
            chatId: built.meta.chatId,
            charId: built.meta.charId,
            groupId: built.meta.groupId,
            lastAiIndex: built.lastAiIndex,
            swipeId: built.meta.swipeId,
            msgFingerprint: built.meta.msgFingerprint,
            quickHintFingerprint: hashStr(hint || ''),
        };
    }

    function snapshotStillCurrent(snap) {
        const c = getCtxSafe();
        if (!c) return false;
        if (ctxChatId(c) !== snap.chatId) return false;
        if (str(c.characterId) !== snap.charId) return false;
        if (str(c.groupId) !== snap.groupId) return false;
        const chat = Array.isArray(c.chat) ? c.chat : [];
        const li = getLastAiIndex(chat);
        if (li !== snap.lastAiIndex) return false;
        const msg = chat[li];
        if (!msg) return false;
        if (getSwipeId(msg) !== snap.swipeId) return false;
        if (msgFingerprint(msg) !== snap.msgFingerprint) return false;
        return true;
    }

    function cancelCurrent(opts) {
        if (!current) return false;
        current.cancelled = true;
        if (current.controller) { try { current.controller.abort('cancelled'); } catch (_) {} }
        if (!opts || !opts.silent) { cooldownUntil = now() + MAIN_COOLDOWN_MS; }
        return true;
    }

    function cancelGeneration() {
        if (!current) return;
        cancelCurrent({ silent: false });
        current = null;
        busy = false;
        setBusyUI(false);
        setPhase('cancelled', '已取消本次生成');
        toast('已取消');
    }

    async function requestGeneration(reason) {
        reason = reason || 'manual';
        const c = getCtxSafe();
        if (!c) { setPhase('error', '无法获取酒馆上下文（getContext 不可用）'); return; }

        let built;
        try { built = buildExcerpt(c); } catch (e) { setPhase('error', errMsg(e)); return; }
        if (!built.ok) { setPhase('empty', built.reason); toast(built.reason); return; }

        const hint = (ui && ui.quickHintInput ? ui.quickHintInput.value : quickHint || '').trim();

        // 主 API 单飞锁：冷却期内、或遗留请求过多则阻止
        if (settings.apiMode !== 'custom') {
            if (pendingMain >= MAX_PENDING_MAIN) { setPhase('error', '有多个未结束的旧请求，请稍候再试'); return; }
            if (pendingMain > 0 && now() < cooldownUntil) { toast('上一个请求尚未结束，请稍等 2 秒'); return; }
        }

        // 顶替旧请求
        cancelCurrent({ silent: true });

        const token = { id: ++reqSeq, cancelled: false, controller: null, snapshot: makeSnapshot(built, hint), reason: reason };
        current = token;
        selfGenerating = true;
        selfGenUntil = now() + SELF_GEN_GUARD_MS;

        busy = true;
        setBusyUI(true);
        setPhase('loading', '正在总结并生成选项…');

        const n = clamp(settings.choiceCount, 2, 6);
        try {
            let raw;
            if (settings.apiMode === 'custom') {
                const ctrl = new AbortController();
                token.controller = ctrl;
                raw = await customChat(buildPrompt(built, hint), token, ctrl);
            } else {
                raw = await callMain(buildPrompt(built, hint));
            }

            if (token.cancelled) { return; } // 逻辑取消：静默丢弃

            if (!snapshotStillCurrent(token.snapshot)) {
                setPhase('expired', '剧情已变化，本次结果已过期（请重新生成）');
                return;
            }
            if (typeof raw !== 'string' || !raw.trim()) {
                throw makeErr('EMPTY', '模型返回为空');
            }

            const parsed = parseResult(raw, n);
            if (!parsed.ok) { setPhase('error', parsed.reason || '解析失败，请重试'); return; }

            const cacheData = {
                version: CACHE_SCHEMA_VERSION,
                summary: parsed.summary,
                choices: parsed.choices,
                swipeId: token.snapshot.swipeId,
                messageFingerprint: token.snapshot.msgFingerprint,
                quickHintFingerprint: token.snapshot.quickHintFingerprint,
                createdAt: now(),
            };
            saveCacheToMessage(built.lastAiIndex, cacheData);
            currentResult = cacheData;
            renderResult(cacheData);
            setPhase('done', '');
        } catch (e) {
            if (token.cancelled) { return; }
            handleRequestError(e);
        } finally {
            if (current === token) {
                current = null;
                busy = false;
                setBusyUI(false);
            }
        }
    }

    function handleRequestError(e) {
        const code = e && e.code;
        if (code === 'TIMEOUT') setPhase('error', '请求超时，请重试或检查接口');
        else if (code === 'ABORTED') setPhase('cancelled', '已取消');
        else if (code === 'CORS') setPhase('error', '请求失败：可能是跨域(CORS)、地址或网络问题');
        else if (code === 'NO_MODEL') setPhase('error', '请先在设置里填写模型');
        else if (code === 'NO_URL' || code === 'BAD_URL' || code === 'BAD_SCHEME' || code === 'INSECURE_URL') setPhase('error', errMsg(e));
        else if (code === 'REASONING_ONLY') setPhase('error', '模型只返回了推理内容，没有最终答复，请更换模型');
        else setPhase('error', '生成失败：' + errMsg(e));
        log('请求失败', code, errMsg(e));
    }

    /* ================================================================
     * §7 结果解析与校验
     * ================================================================ */
    function stripThink(t) {
        for (const tag of THINK_TAGS) {
            const re = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi');
            t = t.replace(re, '');
            const re2 = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*$', 'i');
            t = t.replace(re2, '');
        }
        return t;
    }

    // 从文本中查找“平衡”的 JSON 对象（正确处理字符串与转义）
    function extractBalancedJson(text) {
        const starts = [];
        for (let i = 0; i < text.length; i++) if (text[i] === '{') { starts.push(i); break; }
        if (!starts.length) return null;
        let depth = 0, inStr = false, esc = false, begin = -1;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
                if (esc) { esc = false; }
                else if (ch === '\\') { esc = true; }
                else if (ch === '"') { inStr = false; }
                continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === '{') { if (depth === 0) begin = i; depth++; }
            else if (ch === '}') {
                depth--;
                if (depth === 0 && begin >= 0) {
                    const cand = text.slice(begin, i + 1);
                    const obj = tryJson(cand);
                    if (obj) return obj;
                    begin = -1;
                }
            }
        }
        return null;
    }

    function tryJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

    // 只去除“明确的列表序号”，绝不删除正文开头数字（如 3分钟后）
    function stripListMarker(line) {
        return line.replace(/^\s*(?:\d{1,2}[.)、]\s+|[-*•·]\s+)/, '').trim();
    }

    function cleanTag(tag) {
        let t = str(tag).replace(/[【】\[\]()（）<>《》]/g, '').replace(/[:：\s]+/g, ' ').trim();
        if (t.length > 12) t = t.slice(0, 12);
        return t || '行动';
    }

    function splitTagFromText(text) {
        let s = str(text).trim();
        // 【标签】正文  或 [标签]正文
        let m = s.match(/^[【\[]([^】\]]{1,12})[】\]]\s*([\s\S]+)$/);
        if (m) return { tag: cleanTag(m[1]), text: m[2].trim() };
        // 标签：正文（避免把普通句子里冒号当标签——限制标签字数为 1-12 且无标点）
        m = s.match(/^([^：:\n]{1,12})[：:]\s*([\s\S]+)$/);
        if (m && !/[。！？!?，,\.]/.test(m[1])) return { tag: cleanTag(m[1]), text: m[2].trim() };
        return { tag: '行动', text: s };
    }

    function normalizeChoices(raw, n) {
        let arr = raw;
        if (typeof arr === 'string') arr = arr.split(/\n+/);
        if (!Array.isArray(arr)) return [];
        const out = [];
        const seen = {};
        for (let i = 0; i < arr.length; i++) {
            let item = arr[i];
            let tag = '行动', text = '';
            if (item && typeof item === 'object') {
                tag = cleanTag(item.tag != null ? item.tag : (item.style != null ? item.style : item.label));
                text = str(item.text != null ? item.text : (item.content != null ? item.content : item.action));
                text = stripListMarker(text);
            } else if (typeof item === 'string') {
                const sp = splitTagFromText(stripListMarker(item));
                tag = sp.tag; text = sp.text;
            } else { continue; }
            text = text.replace(/\s+/g, ' ').trim();
            if (!text) continue;
            if (text.length > 600) text = text.slice(0, 600) + '…';
            if (seen[text]) continue;
            seen[text] = 1;
            out.push({ tag: tag, text: text });
            if (out.length >= n) break;
        }
        return out;
    }

    function parseResult(raw, n) {
        if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: '模型没有返回内容' };
        let text = raw.trim();
        // 去代码块包裹
        text = text.replace(/^```[a-zA-Z0-9]*\s*/i, '').replace(/```\s*$/, '').trim();
        // 去思维链
        text = stripThink(text).trim();

        // 1) 直接解析
        let obj = tryJson(text);
        // 2) 平衡括号提取
        if (!obj) obj = extractBalancedJson(text);

        if (obj && (obj.summary != null || obj.choices != null)) {
            const choices = normalizeChoices(obj.choices, n);
            if (!choices.length) return { ok: false, reason: '解析结果里没有可用选项' };
            return { ok: true, summary: str(obj.summary).trim(), choices: choices };
        }

        // 3) 行级兜底解析（仅当确实像“列表/带标签的选项”时才采纳，避免把垃圾文本当选项）
        const srcLines = text.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
        if (srcLines.length >= 2) {
            let summary = '';
            const choiceLines = [];
            let structured = 0;
            for (const raw of srcLines) {
                if (!summary && /^(总结|摘要|概括|summary|tl;?dr)[:：]?/i.test(raw)) {
                    summary = raw.replace(/^(总结一下|总结|摘要|概括|summary|tl;?dr)[:：]?\s*/i, '').trim();
                    continue;
                }
                const hasMarker = /^\s*(?:\d{1,2}[.)、]\s+|[-*•·]\s+)/.test(raw);
                const sp = splitTagFromText(stripListMarker(raw));
                if (hasMarker || sp.tag !== '行动') structured++;
                choiceLines.push(raw);
            }
            const choices = normalizeChoices(choiceLines, n);
            if (choices.length >= 2 && structured >= 2) return { ok: true, summary: summary, choices: choices };
        }
        return { ok: false, reason: '无法解析为有效 JSON（可点重新生成再试）' };
    }

    /* ================================================================
     * §8 消息 / Swipe 级缓存
     * ================================================================ */
    function msgKey(index, swipeId) { return 'c' + index + '_s' + swipeId; }

    function readCacheFromMessage(msg, index, swipeId) {
        try {
            // 1) swipe_info[swipeId].extra.choice_helper
            if (msg && Array.isArray(msg.swipe_info) && msg.swipe_info[swipeId]) {
                const si = msg.swipe_info[swipeId];
                if (si && si.extra && si.extra[CACHE_NS]) return si.extra[CACHE_NS];
            }
            // 2) msg.extra.choice_helper[swipeId]
            if (msg && msg.extra && msg.extra[CACHE_NS] && typeof msg.extra[CACHE_NS] === 'object') {
                const v = msg.extra[CACHE_NS][String(swipeId)];
                if (v) return v;
            }
            // 3) chatMetadata 兼容索引
            const c = getCtxSafe();
            if (c && c.chatMetadata && c.chatMetadata[CACHE_NS]) {
                const v = c.chatMetadata[CACHE_NS][msgKey(index, swipeId)];
                if (v) return v;
            }
        } catch (_) {}
        return null;
    }

    function cacheValidPassive(cache, msg, swipeId) {
        if (!cache || typeof cache !== 'object') return false;
        if (cache.version !== CACHE_SCHEMA_VERSION) return false;
        if (String(cache.swipeId) !== String(swipeId)) return false;
        if (cache.messageFingerprint !== msgFingerprint(msg)) return false;
        if (!Array.isArray(cache.choices) || !cache.choices.length) return false;
        return true;
    }

    function saveCacheToMessage(index, data) {
        const c = getCtxSafe();
        const chat = c && c.chat;
        if (!Array.isArray(chat) || !chat[index]) return false;
        const msg = chat[index];
        const sid = data.swipeId;
        // swipe_info
        try {
            if (!Array.isArray(msg.swipe_info)) msg.swipe_info = [];
            if (!msg.swipe_info[sid]) msg.swipe_info[sid] = {};
            const si = msg.swipe_info[sid];
            if (!isObj(si.extra)) si.extra = {};
            si.extra[CACHE_NS] = data; // 只写自己的命名空间，保留其他扩展数据
        } catch (_) {}
        // msg.extra（同步当前消息）
        try {
            if (!isObj(msg.extra)) msg.extra = {};
            if (!isObj(msg.extra[CACHE_NS])) msg.extra[CACHE_NS] = {};
            msg.extra[CACHE_NS][String(sid)] = data;
        } catch (_) {}
        // chatMetadata 兜底索引
        try {
            if (!isObj(c.chatMetadata)) c.chatMetadata = {};
            if (!isObj(c.chatMetadata[CACHE_NS])) c.chatMetadata[CACHE_NS] = {};
            c.chatMetadata[CACHE_NS][msgKey(index, sid)] = data;
        } catch (_) {}
        // 持久化（可能失败；失败不误报）
        saveChatSafe().then(function (ok) {
            if (!ok) { /* 保存失败：保留内存结果，允许重试 */ }
        });
        return true;
    }

    function restoreFromCache() {
        const c = getCtxSafe();
        if (!c) return false;
        const chat = Array.isArray(c.chat) ? c.chat : [];
        const li = getLastAiIndex(chat);
        if (li < 0) { currentResult = null; renderResult(null); setPhase('empty', '尚无 AI 回复'); return false; }
        const msg = chat[li];
        const sid = getSwipeId(msg);
        const cache = readCacheFromMessage(msg, li, sid);
        if (cache && cacheValidPassive(cache, msg, sid)) {
            currentResult = cache;
            renderResult(cache);
            setPhase('done', '已从缓存恢复上次结果');
            return true;
        }
        currentResult = null;
        renderResult(null);
        setPhase('empty', '');
        return false;
    }

    /* ================================================================
     * §9 生命周期事件与自动模式
     * ================================================================ */
    function bindEvents() {
        const c = getCtxSafe();
        if (!c || !c.eventSource || typeof c.eventSource.on !== 'function') return;
        const ev = ctxEvents(c);
        const on = function (name, handler) { if (name) { try { c.eventSource.on(name, handler); } catch (_) {} } };

        on(ev.CHAT_CHANGED, function () { onChatChanged(); });
        on(ev.CHAT_LOADED, function () { onChatChanged(); });
        on(ev.MESSAGE_SWIPED, function () { onSwipeOrEdit(); });
        on(ev.MESSAGE_DELETED, function () { onSwipeOrEdit(); });
        on(ev.MESSAGE_EDITED, function () { onSwipeOrEdit(); });
        on(ev.MESSAGE_UPDATED, function () { onSwipeOrEdit(); });

        on(ev.GENERATION_STARTED, function () { /* 主剧情开始，取消待触发的自动 */ if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } });
        on(ev.GENERATION_ENDED, function () { if (!selfGenerating) scheduleAuto('gen_ended'); });
        on(ev.GENERATION_STOPPED, function () { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } });
        on(ev.CHARACTER_MESSAGE_RENDERED, function () { if (!selfGenerating) scheduleAuto('char_rendered'); });
    }

    function onChatChanged() {
        // 作废旧请求
        cancelCurrent({ silent: true });
        current = null; busy = false; setBusyUI(false);
        // 清空本轮 Quick Hint
        quickHint = '';
        if (ui && ui.quickHintInput) ui.quickHintInput.value = '';
        // 重置自动去重基准，避免打开历史时对全部旧消息生成
        const c = getCtxSafe();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        lastHandledAiIndex = getLastAiIndex(chat);
        // 恢复/清空
        restoreFromCache();
    }

    function onSwipeOrEdit() {
        cancelCurrent({ silent: true });
        current = null; busy = false; setBusyUI(false);
        restoreFromCache();
    }

    function scheduleAuto(src) {
        if (!settings.autoMode) return;
        if (selfGenerating || busy) return;
        if (now() < selfGenUntil) return; // 自身生成冷却期
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(function () { autoTimer = null; maybeAutoTrigger(src); }, 900);
    }

    function maybeAutoTrigger(src) {
        if (!settings.autoMode || selfGenerating || busy) return;
        const c = getCtxSafe();
        if (!c) return;
        const chat = Array.isArray(c.chat) ? c.chat : [];
        const li = getLastAiIndex(chat);
        if (li < 0) return;
        if (li <= lastHandledAiIndex) return; // 已处理过该条（防止重复/历史回放）
        const msg = chat[li];
        if (!msg || msg.is_user || msg.is_system) return;
        const txt = cleanText(msg.mes != null ? msg.mes : msg.content, { maxChars: 1e9 });
        if (!txt) return;
        const sid = getSwipeId(msg);
        const cache = readCacheFromMessage(msg, li, sid);
        if (cache && cacheValidPassive(cache, msg, sid)) { lastHandledAiIndex = li; return; }
        lastHandledAiIndex = li;
        requestGeneration('auto');
        setTimeout(openPanel, 50);
    }

    /* ================================================================
     * §10 UI
     * ================================================================ */
    function el(tag, attrs, children) {
        const e = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                if (attrs[k] === undefined) continue;
                if (k === 'class') e.className = attrs[k];
                else if (k === 'text') e.textContent = attrs[k];
                else if (k === 'html') e.innerHTML = attrs[k];
                else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
                else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
            }
        }
        if (children) {
            (Array.isArray(children) ? children : [children]).forEach(function (cc) {
                if (cc == null) return;
                e.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc);
            });
        }
        return e;
    }

    function clampFabPos(pos) {
        const size = 54;
        let right = Number(pos && pos.right);
        let bottom = Number(pos && pos.bottom);
        if (!isFinite(right)) right = 18;
        if (!isFinite(bottom)) bottom = 120;
        right = Math.max(8, Math.min(right, Math.max(8, vw() - size)));
        bottom = Math.max(8, Math.min(bottom, Math.max(8, vh() - size)));
        return { right: right, bottom: bottom };
    }

    function applyFabPos() {
        if (!ui) return;
        const p = clampFabPos(settings.fabPos);
        settings.fabPos = p;
        ui.fab.style.right = p.right + 'px';
        ui.fab.style.bottom = p.bottom + 'px';
    }

    function positionPanel() {
        if (!ui) return;
        const p = clampFabPos(settings.fabPos);
        const panelW = Math.min(420, vw() - 24);
        let right = p.right;
        right = Math.max(8, Math.min(right, Math.max(8, vw() - panelW - 8)));
        let bottom = p.bottom + 60;
        bottom = Math.max(8, Math.min(bottom, vh() - 120));
        ui.panel.style.right = right + 'px';
        ui.panel.style.bottom = bottom + 'px';
    }

    function buildUI() {
        if (document.getElementById(UI_ID)) return;

        const fab = el('button', { id: 'ch_fab', title: '剧情推进助手：总结 + 生成选项（可拖动）', text: '🎭' });

        // ---- 拖拽 ----
        let drag = null;
        fab.addEventListener('pointerdown', function (e) {
            if (e.pointerType === 'mouse' && e.button != null && e.button !== 0) return;
            const p = clampFabPos(settings.fabPos);
            drag = { startX: e.clientX, startY: e.clientY, startRight: p.right, startBottom: p.bottom, moved: false, id: e.pointerId, last: p };
            try { fab.setPointerCapture(e.pointerId); } catch (_) {}
        });
        fab.addEventListener('pointermove', function (e) {
            if (!drag) return;
            const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
            if (!drag.moved && Math.sqrt(dx * dx + dy * dy) >= 5) {
                drag.moved = true;
                fab.classList.add('ch-fab-dragging');
            }
            if (drag.moved) {
                drag.last = clampFabPos({ right: drag.startRight - dx, bottom: drag.startBottom - dy });
                fab.style.right = drag.last.right + 'px';
                fab.style.bottom = drag.last.bottom + 'px';
            }
        });
        fab.addEventListener('pointerup', function (e) {
            if (!drag) return;
            try { fab.releasePointerCapture(e.pointerId); } catch (_) {}
            if (drag.moved) { settings.fabPos = drag.last; saveSettings(); }
            else { togglePanel(); }
            fab.classList.remove('ch-fab-dragging');
            drag = null;
        });
        fab.addEventListener('pointercancel', function () { if (drag) { fab.classList.remove('ch-fab-dragging'); drag = null; } });

        // ---- 面板 ----
        const closeBtn = el('button', { class: 'ch-iconbtn', title: '关闭', text: '✕', onclick: closePanel });
        const gearBtn = el('button', { class: 'ch-iconbtn', title: '设置', text: '⚙', onclick: toggleSettings });
        const regenBtn = el('button', { class: 'ch-iconbtn', title: '重新生成', text: '↻', onclick: function () { requestGeneration('regen'); } });

        const head = el('div', { class: 'ch-head' }, [
            el('span', { class: 'ch-title', text: '🎭 剧情推进助手' }),
            el('span', { class: 'ch-spacer' }),
            regenBtn, gearBtn, closeBtn,
        ]);

        const summaryEl = el('div', { id: 'ch_summary', class: 'ch-summary ch-hidden' });
        const statusEl = el('div', { id: 'ch_status', class: 'ch-status' });
        const choicesEl = el('div', { id: 'ch_choices', class: 'ch-choices' });
        const body = el('div', { class: 'ch-body' }, [summaryEl, statusEl, choicesEl]);

        // Quick Hint
        const quickHintInput = el('input', { id: 'ch_quick_hint', class: 'ch-quick-input', type: 'text', placeholder: '💡 本轮走向提示（可选，如：委婉拒绝 / 拔剑反击）' });
        quickHintInput.addEventListener('input', function () { quickHint = quickHintInput.value; });
        quickHintInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); requestGeneration('manual'); }
        });
        const quickClear = el('button', { class: 'ch-iconbtn', title: '清空', text: '✕', onclick: function () { quickHint = ''; quickHintInput.value = ''; quickHintInput.focus(); } });
        const quickWrap = el('div', { class: 'ch-quick-wrap' }, [quickHintInput, quickClear]);

        // 主按钮（生成 / 取消）
        const genBtn = el('button', { id: 'ch_gen', class: 'ch-primary', text: '生成选项' });
        genBtn.addEventListener('click', function () {
            if (busy) cancelGeneration();
            else requestGeneration('manual');
        });
        const foot = el('div', { class: 'ch-foot' }, [genBtn]);

        const hintBar = el('div', { class: 'ch-quick-area' }, [quickWrap]);
        const settingsPanel = buildSettingsPanel();

        const panel = el('div', { id: 'ch_panel', class: 'ch-panel ch-hidden' }, [
            head, body, hintBar, foot, settingsPanel,
        ]);

        const root = el('div', { id: UI_ID }, [fab, panel]);
        document.body.appendChild(root);

        ui = {
            fab: fab, panel: panel, summaryEl: summaryEl, statusEl: statusEl, choicesEl: choicesEl,
            genBtn: genBtn, settingsPanel: settingsPanel, quickHintInput: quickHintInput,
        };
        applyFabPos();
        setBusyUI(false);
        renderResult(null);
        mountExtensionSettingsBlock();

        if (W && typeof W.addEventListener === 'function') {
            W.addEventListener('resize', function () { applyFabPos(); if (!ui.panel.classList.contains('ch-hidden')) positionPanel(); });
        }
    }

    function mountExtensionSettingsBlock() {
        if (document.getElementById('ch_ext_block')) return;
        const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
        if (!host) return;
        const openBtn = el('div', { class: 'menu_button menu_button_icon ch-open-btn', title: '打开剧情推进助手面板' }, [
            el('i', { class: 'fa-solid fa-face-smile' }),
            el('span', { text: ' 打开剧情推进助手面板' }),
        ]);
        openBtn.addEventListener('click', function () { openPanel(); });
        const block = el('div', { class: 'inline-drawer', id: 'ch_ext_block' }, [
            el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
                el('b', { text: '剧情推进助手 (Choice Helper) v2' }),
                el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
            ]),
            el('div', { class: 'inline-drawer-content', style: 'display:none;' }, [
                el('div', { class: 'ch-hint', text: '总结 AI 最新发言并给出可点击的行动选项。也可点聊天界面右下角的 🎭 打开。' }),
                openBtn,
                el('div', { class: 'ch-hint', text: '详细设置（分析用 API、选项数量等）在浮动面板里点 ⚙。' }),
            ]),
        ]);
        host.appendChild(block);
    }

    function buildSettingsPanel() {
        const mkRow = function (label, input, hint) {
            return el('div', { class: 'ch-row' }, [
                el('label', { class: 'ch-label', text: label }),
                input,
                hint ? el('div', { class: 'ch-hint', text: hint }) : null,
            ]);
        };
        const save = function () { saveSettings(); };

        // 选项数量
        const num = el('input', { type: 'number', min: '2', max: '6', value: String(settings.choiceCount), class: 'ch-input ch-num' });
        num.addEventListener('input', function () { settings.choiceCount = clamp(num.value, 2, 6); save(); });

        // 上下文条数
        const ctxNum = el('input', { type: 'number', min: '1', max: '12', value: String(settings.contextMessages), class: 'ch-input ch-num' });
        ctxNum.addEventListener('input', function () { settings.contextMessages = clamp(ctxNum.value, 1, 12); save(); });

        // 单条截断
        const maxChars = el('input', { type: 'number', min: '300', max: '8000', step: '100', value: String(settings.maxCharsPerMsg), class: 'ch-input ch-num' });
        maxChars.addEventListener('input', function () { settings.maxCharsPerMsg = clamp(maxChars.value, 300, 8000); save(); });

        // 复选框
        const mkCheck = function (val, onChange) {
            const cb = el('input', { type: 'checkbox', class: 'ch-check' });
            cb.checked = !!val;
            cb.addEventListener('change', function () { onChange(cb.checked); save(); });
            return cb;
        };
        const autoSend = mkCheck(settings.autoSend, function (v) { settings.autoSend = v; });
        const autoMode = mkCheck(settings.autoMode, function (v) { settings.autoMode = v; });
        const appendMode = mkCheck(settings.appendMode, function (v) { settings.appendMode = v; });
        const showSummary = mkCheck(settings.showSummary, function (v) { settings.showSummary = v; if (currentResult) renderResult(currentResult); });
        const keepDS = mkCheck(settings.keepDetailsStatus, function (v) { settings.keepDetailsStatus = v; });
        const persistKey = mkCheck(settings.persistKey, function (v) { settings.persistKey = v; save(); });

        const style = el('textarea', { class: 'ch-input ch-textarea', rows: '3', placeholder: '例如：请更腹黑/更热血/选项要短一点' });
        style.value = settings.extraStyle || '';
        style.addEventListener('input', function () { settings.extraStyle = style.value; save(); });

        // ---- 分析用 API ----
        const modeSelect = el('select', { class: 'ch-input' });
        const optMain = el('option', { value: 'main' }); optMain.textContent = '跟随主 API（默认）';
        const optCustom = el('option', { value: 'custom' }); optCustom.textContent = '自定义 API（自填 URL / Key）';
        modeSelect.appendChild(optMain); modeSelect.appendChild(optCustom);
        modeSelect.value = settings.apiMode === 'custom' ? 'custom' : 'main';

        const urlInput = el('input', { type: 'text', class: 'ch-input', placeholder: 'https://api.deepseek.com/v1' });
        urlInput.value = settings.customBaseUrl || '';
        urlInput.addEventListener('input', function () { settings.customBaseUrl = urlInput.value.trim(); save(); });

        const keyInput = el('input', { type: 'password', class: 'ch-input', placeholder: 'sk-...（仅存本机；可勾选会话保存）' });
        keyInput.value = settings.customApiKey || '';
        keyInput.addEventListener('input', function () { settings.customApiKey = keyInput.value.trim(); save(); });

        const modelInput = el('input', { type: 'text', class: 'ch-input', placeholder: '模型名，如 deepseek-chat' });
        modelInput.value = settings.customModel || '';
        modelInput.addEventListener('input', function () { settings.customModel = modelInput.value.trim(); save(); });

        const modelSelect = el('select', { class: 'ch-input ch-hidden' });
        modelSelect.addEventListener('change', function () { if (modelSelect.value) { settings.customModel = modelSelect.value; modelInput.value = modelSelect.value; save(); } });

        const fetchBtn = el('button', { class: 'ch-mini', text: '获取模型' });
        fetchBtn.addEventListener('click', async function () {
            const old = fetchBtn.textContent;
            fetchBtn.disabled = true; fetchBtn.textContent = '获取中…';
            try {
                settings.customBaseUrl = urlInput.value.trim();
                settings.customApiKey = keyInput.value.trim();
                save();
                const list = await fetchModels();
                if (!list.length) { toast('接口没有返回模型列表（可能不支持 /models，可手动填模型名）'); }
                else {
                    modelSelect.innerHTML = '';
                    const o0 = el('option', { value: '' }); o0.textContent = '— 选择模型（共 ' + list.length + '）—'; modelSelect.appendChild(o0);
                    list.forEach(function (m) { const o = el('option', { value: m }); o.textContent = m; modelSelect.appendChild(o); });
                    modelSelect.classList.remove('ch-hidden');
                    if (settings.customModel && list.indexOf(settings.customModel) >= 0) modelSelect.value = settings.customModel;
                    toast('已获取 ' + list.length + ' 个模型');
                }
            } catch (e) { toast(errMsg(e)); }
            finally { fetchBtn.disabled = false; fetchBtn.textContent = old; }
        });

        const maxOut = el('input', { type: 'number', min: '64', max: '32000', step: '100', value: String(settings.maxOutputTokens), class: 'ch-input ch-num' });
        maxOut.addEventListener('input', function () { settings.maxOutputTokens = clamp(maxOut.value, 64, 32000); save(); });
        const tempInput = el('input', { type: 'number', min: '0', max: '2', step: '0.1', value: settings.temperature === '' ? '' : String(settings.temperature), class: 'ch-input ch-num', placeholder: '留空=不发送' });
        tempInput.addEventListener('input', function () { settings.temperature = tempInput.value === '' ? '' : String(tempInput.value); save(); });
        const timeoutInput = el('input', { type: 'number', min: '5', max: '300', step: '5', value: String(settings.requestTimeout), class: 'ch-input ch-num' });
        timeoutInput.addEventListener('input', function () { settings.requestTimeout = clamp(timeoutInput.value, 5, 300); save(); });

        const modelWrap = el('div', { class: 'ch-apirow' }, [modelInput, fetchBtn]);
        const customFields = el('div', { id: 'ch_custom_fields', class: 'ch-custom-fields' + (settings.apiMode === 'custom' ? '' : ' ch-hidden') }, [
            el('div', { class: 'ch-hint', text: 'OpenAI 兼容接口。接口地址填到 /v1（如 https://api.deepseek.com/v1）。Key 只存本机，不上传别处。' }),
            mkRow('接口地址', urlInput),
            mkRow('API Key', keyInput),
            mkRow('模型', modelWrap),
            modelSelect,
            mkRow('最大输出 Tokens', maxOut, '推理模型建议 2000+'),
            mkRow('温度', tempInput, '留空=不发送 temperature'),
            mkRow('请求超时(秒)', timeoutInput, '默认 60'),
        ]);

        modeSelect.addEventListener('change', function () {
            settings.apiMode = modeSelect.value === 'custom' ? 'custom' : 'main';
            save();
            customFields.classList.toggle('ch-hidden', settings.apiMode !== 'custom');
        });
        const apiBlock = el('div', { class: 'ch-api-block' }, [modeSelect, customFields]);

        return el('div', { id: 'ch_settings', class: 'ch-settings ch-hidden' }, [
            el('div', { class: 'ch-settings-title', text: '设置' }),
            mkRow('分析用 API', apiBlock, '① 跟随主 API（默认）② 自定义 API（自填 URL/Key，可自动获取模型）。自定义只影响“总结/选项”。'),
            mkRow('记住 Key（关=仅本会话）', persistKey, '关闭时设置存 sessionStorage，关浏览器即清'),
            mkRow('选项数量', num, '2–6 个'),
            mkRow('上下文消息数', ctxNum, '读取最近几条消息用于总结'),
            mkRow('单条截断字符', maxChars, '超长消息保留首尾，保结尾剧情'),
            mkRow('保留 details/status 正文', keepDS, '默认移除整块；勾选则只去标签保留正文'),
            mkRow('点击后自动发送', autoSend, '输入框已有草稿时不会自动发送'),
            mkRow('追加模式（不覆盖草稿）', appendMode, '关闭则覆盖输入框内容'),
            mkRow('自动模式', autoMode, 'AI 每次回复后自动生成（有防抖与去重）'),
            mkRow('显示总结', showSummary, ''),
            mkRow('额外风格要求', style, '可留空'),
            el('div', { class: 'ch-hint', text: '设置即时保存。' }),
        ]);
    }

    function renderResult(res) {
        if (!ui) return;
        const has = res && (res.summary || (res.choices && res.choices.length));
        ui.choicesEl.innerHTML = '';
        if (!has) {
            ui.summaryEl.textContent = '';
            ui.summaryEl.classList.add('ch-hidden');
            return;
        }
        if (settings.showSummary && res.summary) {
            ui.summaryEl.textContent = '📌 ' + res.summary;
            ui.summaryEl.classList.remove('ch-hidden');
        } else {
            ui.summaryEl.textContent = '';
            ui.summaryEl.classList.add('ch-hidden');
        }
        (res.choices || []).forEach(function (c, i) {
            const tag = c && c.tag ? c.tag : '行动';
            const text = c && c.text ? c.text : str(c);
            const bodySpan = el('span', { class: 'ch-choice-body' }, [
                el('span', { class: 'ch-choice-tag', text: '[' + tag + ']' }),
                el('span', { class: 'ch-choice-text', text: text }),
            ]);
            const b = el('button', { class: 'ch-choice' }, [
                el('span', { class: 'ch-choice-idx', text: String(i + 1) }),
                bodySpan,
            ]);
            b.addEventListener('click', function () { insertChoice(text); });
            ui.choicesEl.appendChild(b);
        });
    }

    // 空状态 / 错误 / 加载 统一阶段控制
    function setPhase(kind, msg) {
        if (!ui) return;
        ui.statusEl.textContent = '';
        ui.statusEl.className = 'ch-status';
        if (kind === 'loading') {
            ui.statusEl.classList.add('ch-status-loading');
            const sp = el('span', { class: 'ch-spinner' });
            ui.statusEl.appendChild(sp);
            ui.statusEl.appendChild(document.createTextNode(' ' + (msg || '正在生成…')));
        } else if (kind === 'error') {
            ui.statusEl.classList.add('ch-status-error');
            ui.statusEl.textContent = '⚠️ ' + (msg || '出错了');
        } else if (kind === 'empty') {
            ui.statusEl.classList.add('ch-status-empty');
            ui.statusEl.textContent = msg || '点下方「生成选项」：会自动总结 AI 最新发言并给出可点击的行动选项。';
        } else if (kind === 'cancelled') {
            ui.statusEl.classList.add('ch-status-muted');
            ui.statusEl.textContent = msg || '已取消';
        } else if (kind === 'expired') {
            ui.statusEl.classList.add('ch-status-error');
            ui.statusEl.textContent = '⚠️ ' + (msg || '结果已过期，请重新生成');
        } else if (kind === 'done') {
            if (msg) { ui.statusEl.classList.add('ch-status-muted'); ui.statusEl.textContent = msg; }
        }
    }

    function setBusyUI(on) {
        busy = !!on;
        if (!ui) return;
        const b = ui.genBtn;
        b.textContent = on ? '⏹ 取消生成' : '生成选项';
        b.classList.toggle('ch-danger', !!on);
        b.classList.toggle('ch-primary', !on);
        b.disabled = false;
    }

    function insertChoice(text) {
        const ta = document.getElementById('send_textarea');
        if (!ta) { toast('找不到输入框'); return; }
        const existing = str(ta.value);
        const hadDraft = existing.trim().length > 0;
        const add = str(text).trim();
        if (hadDraft && settings.appendMode) {
            ta.value = existing.replace(/\s+$/, '') + '\n' + add;
        } else {
            ta.value = add;
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        try { ta.focus(); if (ta.setSelectionRange) ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}

        if (settings.autoSend && !hadDraft) {
            const btn = document.getElementById('send_but');
            if (btn) setTimeout(function () { btn.click(); }, 60);
        } else if (settings.autoSend && hadDraft) {
            toast('输入框已有草稿，已追加选项但未自动发送，请确认后再发');
        } else {
            toast(hadDraft ? '已追加到输入框（未覆盖草稿）' : '已填入输入框，按回车发送');
        }
        closePanel();
    }

    function openPanel() { if (!ui) return; ui.panel.classList.remove('ch-hidden'); ui.fab.classList.add('ch-fab-active'); positionPanel(); if (!currentResult) restoreFromCache(); }
    function closePanel() { if (!ui) return; ui.panel.classList.add('ch-hidden'); ui.fab.classList.remove('ch-fab-active'); }
    function togglePanel() { if (!ui) return; if (ui.panel.classList.contains('ch-hidden')) openPanel(); else closePanel(); }
    function toggleSettings() { if (!ui) return; ui.settingsPanel.classList.toggle('ch-hidden'); }

    /* ================================================================
     * §11 初始化
     * ================================================================ */
    function boot() {
        let tries = 0;
        const timer = setInterval(function () {
            tries++;
            if (document.getElementById('send_textarea') && document.body) {
                clearInterval(timer);
                try {
                    settings = loadSettings();
                    buildUI();
                    bindEvents();
                    restoreFromCache();
                    log('已加载 v2.0.0');
                } catch (e) { log('初始化失败', e); }
            } else if (tries > 100) {
                clearInterval(timer);
                log('等待聊天界面超时，未初始化');
            }
        }, 300);
    }

    // 测试钩子（仅当外部显式设置 __CH_TEST_HOOK__ 时暴露内部函数，生产环境不生效）
    if (globalThis.__CH_TEST_HOOK__) {
        globalThis.__CH_INTERNAL__ = {
            cleanText: cleanText, smartTruncate: smartTruncate, parseResult: parseResult,
            normalizeChoices: normalizeChoices, stripListMarker: stripListMarker,
            splitTagFromText: splitTagFromText, hashStr: hashStr, getSwipeId: getSwipeId,
            msgFingerprint: msgFingerprint, sanitizeSettings: sanitizeSettings,
            buildExcerpt: buildExcerpt, buildPrompt: buildPrompt,
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
