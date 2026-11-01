/*
 * 剧情推进助手 (Choice Helper) — SillyTavern 第三方扩展
 * ------------------------------------------------------------------
 * 作用：读取最近一段对话，用「纯净补全(generateRaw)」让模型
 *       ① 总结最新一条 AI 回复  ② 生成若干个可直接点击的行动选项，
 *       点击后自动填入输入框（可选自动发送），方便推进剧情。
 *
 * 特点：
 *  - 不污染角色卡/世界书（走 generateRaw，而不是带卡预设的 quiet 生成）
 *  - 无构建、无外部依赖、无第三方库
 *  - 兼容 SillyTavern 1.12+（Docker 部署同款前端即可用）
 *  - 设置保存在浏览器 localStorage，跨刷新/跨重启仍在
 *
 * 作者：LittleCodeSauce   版本：1.0.0
 */

(function () {
    'use strict';

    const TAG = '[剧情助手]';
    const STORE_KEY = 'choice_helper_settings_v1';
    const UI_ID = 'ch_root';

    const DEFAULTS = {
        choiceCount: 4,        // 生成几个选项 (2-6)
        contextMessages: 4,    // 读取最近几条消息作为上下文
        maxCharsPerMsg: 1400,  // 每条消息截断长度
        autoSend: false,       // 点击选项后是否自动发送
        autoMode: false,       // AI 回复后是否自动生成选项
        showSummary: true,     // 是否显示总结
        extraStyle: '',        // 额外风格要求（自由填写）
        profileId: '',         // 分析用「连接配置(Connection Profile)」ID；空 = 跟随主 API
    };

    let settings = loadSettings();
    let busy = false;
    let autoTimer = null;
    let lastResult = { summary: '', choices: [] };
    let ui = null;

    // ---------------------------------------------------------------- utils
    function log(...a) { try { console.log(TAG, ...a); } catch (_) {} }
    function clamp(n, lo, hi) { n = Number(n); if (isNaN(n)) n = lo; return Math.max(lo, Math.min(hi, n)); }

    function getCtx() {
        const c = globalThis.SillyTavern && globalThis.SillyTavern.getContext
            ? globalThis.SillyTavern.getContext()
            : null;
        if (!c) throw new Error('无法获取酒馆上下文（getContext 不可用），请确认是 SillyTavern 1.12+');
        return c;
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
        } catch (_) { return Object.assign({}, DEFAULTS); }
    }
    function saveSettings() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) {}
    }

    // 简易 toast（不依赖酒馆的 toastr）
    function toast(msg) {
        let box = document.getElementById('ch_toast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'ch_toast';
            document.body.appendChild(box);
        }
        box.textContent = String(msg);
        box.classList.add('ch-toast-show');
        clearTimeout(box._t);
        box._t = setTimeout(() => box.classList.remove('ch-toast-show'), 3200);
    }

    function findLastAiIndex(chat) {
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            if (!m.is_user) return i;
        }
        return -1;
    }

    function cleanText(s) {
        if (!s) return '';
        let t = String(s);
        t = t.replace(/```[\s\S]*?```/g, ' ');      // 代码块/前端脚本
        t = t.replace(/<[^>]+>/g, ' ');             // 各种标签
        t = t.replace(/\{\{[\s\S]*?\}\}/g, ' ');     // 残留宏
        t = t.replace(/[ \t\u00a0]+/g, ' ');
        t = t.replace(/\n{3,}/g, '\n\n').trim();
        const max = clamp(settings.maxCharsPerMsg, 200, 6000);
        if (t.length > max) t = t.slice(0, max) + '…';
        return t;
    }

    // ---------------------------------------------------------------- core
    function buildExcerpt() {
        const c = getCtx();
        const chat = Array.isArray(c.chat) ? c.chat : [];
        if (!chat.length) return { ok: false, reason: '当前没有聊天内容，请先开始一段对话。' };

        const lastAi = findLastAiIndex(chat);
        if (lastAi < 0) return { ok: false, reason: '还没找到 AI 的发言，先让 AI 回复一次。' };

        const n = clamp(settings.contextMessages, 1, 12);
        const start = Math.max(0, lastAi - n + 1);
        const lines = [];
        for (let i = start; i <= lastAi; i++) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            const text = cleanText(m.mes || m.content || '');
            if (!text) continue;
            const who = m.is_user ? '用户' : (m.name || 'AI');
            lines.push(who + '：' + text);
        }
        if (!lines.length) return { ok: false, reason: '最近的消息没有可总结的文本（可能都是空的）。' };
        return { ok: true, excerpt: lines.join('\n\n') };
    }

    function buildPrompt(excerpt) {
        const n = clamp(settings.choiceCount, 2, 6);
        const parts = [];
        parts.push('下面是一段互动剧情的最近对话（按时间顺序）：');
        parts.push('-----');
        parts.push(excerpt);
        parts.push('-----');
        parts.push('');
        parts.push('请完成两件事：');
        parts.push('1) 用 1-2 句中文总结【最新一条 AI 回复】发生了什么：主角当前处境、他人反应、以及最关键的矛盾或机会点。');
        parts.push(`2) 给出 ${n} 个玩家接下来【可以直接采取】的行动选项。每个选项是一句自然的中文（第一人称、可当作玩家的发言或行动直接发送），要具体、可执行、彼此风格不同（例如：谨慎试探 / 大胆进攻 / 社交套话 / 探索调查 / 幽默搞事 等），并且都能推动剧情。`);
        if (settings.extraStyle && settings.extraStyle.trim()) {
            parts.push('');
            parts.push('【额外风格要求】' + settings.extraStyle.trim());
        }
        parts.push('');
        parts.push('严格只输出一个 JSON 对象，格式如下，不要任何多余文字、不要 Markdown 代码块、不要 <UpdateVariable> 之类的标签：');
        parts.push('{"summary":"（一句话总结）","choices":["（选项1）","（选项2）","（选项3）"]}');
        return parts.join('\n');
    }

    const SYSTEM_PROMPT =
        '你是一个中文互动小说 / 跑团的“剧情推进助手”。你只站在玩家一侧提供帮助：' +
        '总结局势、给出可执行的行动建议。你不扮演任何角色、不续写正文、不做心理描写堆砌、' +
        '不输出任何标签或代码块。你的输出必须是一个严格合法的 JSON 对象。';

    // 读取酒馆里可用的「连接配置(Connection Profile)」，返回 {id,name,model} 列表
    function listProfiles() {
        const c = getCtx();
        const svc = c.ConnectionManagerRequestService;
        if (!svc || typeof svc.getSupportedProfiles !== 'function') return [];
        try {
            return (svc.getSupportedProfiles() || []).map((p) => ({
                id: p.id,
                name: p.name || p.id,
                model: p.model || '',
                api: p.api,
            }));
        } catch (_) { return []; }
    }

    async function runRaw(prompt) {
        const c = getCtx();
        const responseLength = 700;

        // 0) 独立「连接配置」优先：用你另建的便宜 API 发请求，完全不碰主 API
        if (settings.profileId) {
            const svc = c.ConnectionManagerRequestService;
            if (!svc || typeof svc.sendRequest !== 'function') {
                throw new Error('连接配置服务不可用：请在酒馆扩展里启用「连接管理/Connection Manager」，并新建一个 API 配置');
            }
            // 判断该配置是 Chat Completion 还是 Text Completion
            let chatStyle = true;
            try {
                const prof = listProfiles().find((p) => p.id === settings.profileId);
                const map = c.CONNECT_API_MAP && prof ? c.CONNECT_API_MAP[prof.api] : null;
                chatStyle = !map || map.selected === 'openai';
            } catch (_) { chatStyle = true; }
            const messagePayload = chatStyle
                ? [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }]
                : (SYSTEM_PROMPT + '\n\n' + prompt);
            const res = await svc.sendRequest(settings.profileId, messagePayload, responseLength, {
                stream: false,
                extractData: true,
                includePreset: false,
                includeInstruct: false,
            });
            if (typeof res === 'string') return res;
            return String((res && (res.content != null ? res.content : res.text)) || '');
        }

        // 首选：generateRaw —— 纯净补全，不带角色卡/世界书/聊天历史
        if (typeof c.generateRaw === 'function') {
            return await c.generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, responseLength: responseLength });
        }
        // 次选：generateQuietPrompt —— 会带上聊天上下文，但也可用
        if (typeof c.generateQuietPrompt === 'function') {
            return await c.generateQuietPrompt({
                quietPrompt: prompt,
                quietName: '剧情助手',
                skipWIAN: true,
                responseLength: responseLength,
            });
        }
        // 末选：直接从 script.js 动态取函数（同源）
        for (const spec of ['/script.js', '../../../script.js', '../../../../script.js']) {
            try {
                const m = await import(/* @vite-ignore */ spec);
                if (typeof m.generateRaw === 'function') {
                    return await m.generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, responseLength: responseLength });
                }
                if (typeof m.generateQuietPrompt === 'function') {
                    return await m.generateQuietPrompt({ quietPrompt: prompt, quietName: '剧情助手', skipWIAN: true, responseLength: responseLength });
                }
            } catch (_) { /* try next */ }
        }
        throw new Error('当前酒馆版本没有可用的生成接口（generateRaw/generateQuietPrompt 均不可用）');
    }

    function tryJson(text) {
        try { return JSON.parse(text); } catch (_) { return null; }
    }

    function normalizeChoices(raw, n) {
        let arr = raw;
        if (typeof arr === 'string') {
            arr = arr.split(/\n+/);
        }
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (let item of arr) {
            if (item == null) continue;
            let s = String(item).replace(/^[\s\-*•·\d]+[\.\)、:：]?\s*/, '').trim();
            if (!s) continue;
            out.push(s);
            if (out.length >= n) break;
        }
        return out;
    }

    function parseResult(raw, n) {
        if (!raw || typeof raw !== 'string') return { summary: '', choices: [] };
        let text = raw.trim();
        text = text.replace(/^```[a-zA-Z0-9]*\s*/i, '').replace(/```\s*$/, '').trim();
        text = text.replace(/<\/?think>/gi, '').trim();

        let obj = tryJson(text);
        if (!obj) {
            const i = text.indexOf('{');
            const j = text.lastIndexOf('}');
            if (i >= 0 && j > i) obj = tryJson(text.slice(i, j + 1));
        }
        if (obj && (obj.summary != null || obj.choices != null)) {
            return {
                summary: String(obj.summary || '').trim(),
                choices: normalizeChoices(obj.choices, n),
            };
        }
        // 兜底：逐行拆分，识别“总结/摘要”行，其余当作选项
        const rawLines = text.split(/\n+/)
            .map((s) => s.replace(/^[\s\-*•·\d]+[\.\)、:：]?\s*/, '').trim())
            .filter(Boolean);
        if (rawLines.length) {
            let summary = '';
            const choices = [];
            for (const ln of rawLines) {
                if (!summary && /^(总结|摘要|概括|总结一下|summary|tl;?dr)[:：]?/i.test(ln)) {
                    summary = ln.replace(/^(总结一下|总结|摘要|概括|summary|tl;?dr)[:：]?\s*/i, '').trim();
                } else {
                    choices.push(ln);
                }
            }
            if (!summary && choices.length > n) summary = choices.shift();
            return { summary, choices: choices.slice(0, n) };
        }
        return { summary: text.slice(0, 200), choices: [] };
    }

    async function generateChoices() {
        if (busy) return;
        let built;
        try { built = buildExcerpt(); }
        catch (e) { toast(e.message || String(e)); return; }
        if (!built.ok) { toast(built.reason); return; }

        setBusy(true);
        showLoading(true);
        hideResult();
        try {
            const raw = await runRaw(buildPrompt(built.excerpt));
            const n = clamp(settings.choiceCount, 2, 6);
            lastResult = parseResult(raw, n);
            renderResult(lastResult);
            if (!lastResult.choices.length) toast('没解析出选项，可点“重新生成”再试一次。');
        } catch (e) {
            log('生成失败', e);
            const msg = (e && e.cause && e.cause.message) ? e.cause.message : (e && e.message ? e.message : e);
            toast('生成失败：' + msg);
        } finally {
            showLoading(false);
            setBusy(false);
        }
    }

    // ---------------------------------------------------------------- insert
    function insertChoice(text) {
        const ta = document.getElementById('send_textarea');
        if (!ta) { toast('找不到输入框'); return; }
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
        if (settings.autoSend) {
            const btn = document.getElementById('send_but');
            if (btn) setTimeout(() => btn.click(), 60);
        } else {
            toast('已填入输入框，按回车发送（可在设置里开启自动发送）');
        }
        closePanel();
    }

    // ---------------------------------------------------------------- UI
    function el(tag, attrs, children) {
        const e = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                if (k === 'class') e.className = attrs[k];
                else if (k === 'text') e.textContent = attrs[k];
                else if (k === 'html') e.innerHTML = attrs[k];
                else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
                else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
            }
        }
        if (children) {
            (Array.isArray(children) ? children : [children]).forEach((c) => {
                if (c == null) return;
                e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
            });
        }
        return e;
    }

    function buildUI() {
        if (document.getElementById(UI_ID)) return;

        const fab = el('button', { id: 'ch_fab', title: '剧情推进助手：总结 + 生成选项', text: '🎭' });
        fab.addEventListener('click', () => { togglePanel(); });

        const closeBtn = el('button', { class: 'ch-iconbtn', title: '关闭', text: '✕', onclick: closePanel });
        const gearBtn = el('button', { class: 'ch-iconbtn', title: '设置', text: '⚙', onclick: () => toggleSettings() });
        const regenBtn = el('button', { class: 'ch-iconbtn', title: '重新生成', text: '↻', onclick: () => generateChoices() });

        const head = el('div', { class: 'ch-head' }, [
            el('span', { class: 'ch-title', text: '🎭 剧情推进助手' }),
            el('span', { class: 'ch-spacer' }),
            regenBtn, gearBtn, closeBtn,
        ]);

        const summaryEl = el('div', { id: 'ch_summary', class: 'ch-summary' });
        const choicesEl = el('div', { id: 'ch_choices', class: 'ch-choices' });
        const loadingEl = el('div', { id: 'ch_loading', class: 'ch-loading ch-hidden' }, [
            el('span', { class: 'ch-spinner' }),
            el('span', { text: ' 正在总结并生成选项…' }),
        ]);
        const emptyEl = el('div', { id: 'ch_empty', class: 'ch-empty' }, [
            el('div', { text: '点下方「生成选项」：' }),
            el('div', { class: 'ch-hint', text: '会自动总结 AI 最新发言，并给出几个可直接点击的行动选项。' }),
        ]);

        const body = el('div', { class: 'ch-body' }, [summaryEl, emptyEl, loadingEl, choicesEl]);
        const genBtn = el('button', { id: 'ch_gen', class: 'ch-primary', text: '生成选项', onclick: () => generateChoices() });
        const foot = el('div', { class: 'ch-foot' }, [genBtn]);

        const settingsPanel = buildSettingsPanel();

        const panel = el('div', { id: 'ch_panel', class: 'ch-panel ch-hidden' }, [
            head, body, foot, settingsPanel,
        ]);

        const root = el('div', { id: UI_ID }, [fab, panel]);
        document.body.appendChild(root);

        ui = { fab, panel, summaryEl, choicesEl, loadingEl, emptyEl, genBtn, settingsPanel };
        renderResult(lastResult);
        mountExtensionSettingsBlock();
    }

    // 在「扩展程序」抽屉里挂一个设置面板，让它出现在扩展列表里、可展开
    function mountExtensionSettingsBlock() {
        if (document.getElementById('ch_ext_block')) return;
        const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
        if (!host) return;
        const openBtn = el('div', { class: 'menu_button menu_button_icon ch-open-btn', title: '打开剧情推进助手面板' }, [
            el('i', { class: 'fa-solid fa-face-smile' }),
            el('span', { text: ' 打开剧情推进助手面板' }),
        ]);
        openBtn.addEventListener('click', () => { openPanel(); });
        const block = el('div', { class: 'inline-drawer', id: 'ch_ext_block' }, [
            el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
                el('b', { text: '剧情推进助手 (Choice Helper)' }),
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
        const mkRow = (label, input, hint) => el('div', { class: 'ch-row' }, [
            el('label', { class: 'ch-label', text: label }),
            input,
            hint ? el('div', { class: 'ch-hint', text: hint }) : null,
        ]);

        const num = el('input', { type: 'number', min: '2', max: '6', value: String(settings.choiceCount), class: 'ch-input ch-num' });
        num.addEventListener('change', () => { settings.choiceCount = clamp(num.value, 2, 6); num.value = settings.choiceCount; saveSettings(); });

        const ctxNum = el('input', { type: 'number', min: '1', max: '12', value: String(settings.contextMessages), class: 'ch-input ch-num' });
        ctxNum.addEventListener('change', () => { settings.contextMessages = clamp(ctxNum.value, 1, 12); ctxNum.value = settings.contextMessages; saveSettings(); });

        const autoSend = el('input', { type: 'checkbox', class: 'ch-check' });
        autoSend.checked = !!settings.autoSend;
        autoSend.addEventListener('change', () => { settings.autoSend = autoSend.checked; saveSettings(); });

        const autoMode = el('input', { type: 'checkbox', class: 'ch-check' });
        autoMode.checked = !!settings.autoMode;
        autoMode.addEventListener('change', () => { settings.autoMode = autoMode.checked; saveSettings(); });

        const showSummary = el('input', { type: 'checkbox', class: 'ch-check' });
        showSummary.checked = !!settings.showSummary;
        showSummary.addEventListener('change', () => { settings.showSummary = showSummary.checked; saveSettings(); renderResult(lastResult); });

        const style = el('textarea', { class: 'ch-input ch-textarea', rows: '3', placeholder: '例如：请更腹黑/更热血/选项要短一点' });
        style.value = settings.extraStyle || '';
        style.addEventListener('change', () => { settings.extraStyle = style.value; saveSettings(); });

        // 分析用 API（酒馆「连接配置 / Connection Profile」）
        const profileSelect = el('select', { class: 'ch-input' });
        const refreshBtn = el('button', { class: 'ch-mini', text: '刷新', title: '重新读取连接配置' });
        const populateProfiles = () => {
            profileSelect.innerHTML = '';
            const opt = (val, text) => { const o = el('option', { value: val }); o.textContent = text; return o; };
            profileSelect.appendChild(opt('', '跟随主 API（默认）'));
            const list = listProfiles();
            list.forEach((p) => profileSelect.appendChild(opt(p.id, p.name + (p.model ? ' · ' + p.model : ''))));
            if (settings.profileId && !list.some((p) => p.id === settings.profileId)) {
                settings.profileId = ''; saveSettings();
            }
            profileSelect.value = settings.profileId || '';
        };
        profileSelect.addEventListener('change', () => { settings.profileId = profileSelect.value || ''; saveSettings(); });
        refreshBtn.addEventListener('click', () => { populateProfiles(); });
        populateProfiles();
        const apiWrap = el('div', { class: 'ch-apirow' }, [profileSelect, refreshBtn]);

        return el('div', { id: 'ch_settings', class: 'ch-settings ch-hidden' }, [
            el('div', { class: 'ch-settings-title', text: '设置' }),
            mkRow('分析用 API', apiWrap, '空=跟随主 API。选一个便宜配置，总结/选项只走它，不花主力模型的 token。需先在酒馆「扩展 → 连接管理(Connection Manager)」里建好该配置。'),
            mkRow('选项数量', num, '2–6 个'),
            mkRow('上下文消息数', ctxNum, '读取最近几条消息用于总结'),
            mkRow('点击后自动发送', autoSend, '关闭时只填入输入框，你自己确认再发'),
            mkRow('自动模式', autoMode, 'AI 每次回复后自动生成顶部选项（会多耗 token）'),
            mkRow('显示总结', showSummary, ''),
            mkRow('额外风格要求', style, '可留空'),
            el('div', { class: 'ch-hint', text: '设置即时保存到本浏览器。' }),
        ]);
    }

    function renderResult(res) {
        if (!ui) return;
        const has = res && (res.summary || (res.choices && res.choices.length));
        if (!has) {
            ui.summaryEl.textContent = '';
            ui.choicesEl.innerHTML = '';
            ui.emptyEl.classList.remove('ch-hidden');
            return;
        }
        ui.emptyEl.classList.add('ch-hidden');

        if (settings.showSummary && res.summary) {
            ui.summaryEl.textContent = '📌 ' + res.summary;
            ui.summaryEl.classList.remove('ch-hidden');
        } else {
            ui.summaryEl.textContent = '';
            ui.summaryEl.classList.add('ch-hidden');
        }

        ui.choicesEl.innerHTML = '';
        (res.choices || []).forEach((text, i) => {
            const b = el('button', { class: 'ch-choice' }, [
                el('span', { class: 'ch-choice-idx', text: String(i + 1) }),
                el('span', { class: 'ch-choice-text', text: text }),
            ]);
            b.addEventListener('click', () => insertChoice(text));
            ui.choicesEl.appendChild(b);
        });
    }

    function showLoading(on) {
        if (!ui) return;
        if (on) { ui.loadingEl.classList.remove('ch-hidden'); ui.emptyEl.classList.add('ch-hidden'); }
        else { ui.loadingEl.classList.add('ch-hidden'); }
    }
    function hideResult() {
        if (!ui) return;
        ui.summaryEl.textContent = '';
        ui.choicesEl.innerHTML = '';
    }

    function setBusy(on) {
        busy = on;
        if (ui && ui.genBtn) {
            ui.genBtn.disabled = on;
            ui.genBtn.textContent = on ? '生成中…' : '生成选项';
        }
    }

    function openPanel() {
        if (!ui) return;
        ui.panel.classList.remove('ch-hidden');
        ui.fab && ui.fab.classList.add('ch-fab-active');
    }
    function closePanel() {
        if (!ui) return;
        ui.panel.classList.add('ch-hidden');
        ui.fab && ui.fab.classList.remove('ch-fab-active');
    }
    function togglePanel() {
        if (!ui) return;
        if (ui.panel.classList.contains('ch-hidden')) openPanel(); else closePanel();
    }
    function toggleSettings() {
        if (!ui) return;
        ui.settingsPanel.classList.toggle('ch-hidden');
    }

    // ---------------------------------------------------------------- auto mode
    function bindAutoMode() {
        let c;
        try { c = getCtx(); } catch (_) { return; }
        if (!c.eventSource || !c.eventTypes) return;
        const evName = c.eventTypes.CHARACTER_MESSAGE_RENDERED || c.eventTypes.MESSAGE_RECEIVED;
        if (!evName) return;
        c.eventSource.on(evName, () => {
            if (!settings.autoMode) return;
            if (busy) return;
            clearTimeout(autoTimer);
            autoTimer = setTimeout(() => {
                if (settings.autoMode && !busy) {
                    generateChoices();
                    setTimeout(openPanel, 50);
                }
            }, 1200);
        });
    }

    // ---------------------------------------------------------------- boot
    function boot() {
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (document.getElementById('send_textarea') && document.body) {
                clearInterval(timer);
                try {
                    buildUI();
                    bindAutoMode();
                    log('已加载');
                } catch (e) {
                    log('初始化失败', e);
                }
            } else if (tries > 100) {
                clearInterval(timer);
                log('等待聊天界面超时，未初始化');
            }
        }, 300);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
