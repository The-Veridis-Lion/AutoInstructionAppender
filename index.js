(function () {
  const EXT_KEY = 'auto_instruction_appender';
  
  const DEFAULT_INSTRUCTIONS = [
    '（仅针对 <content></content> 标签内的内容生效：请生成2500字以上的长文。要求合并细碎段落，保持长短段错落有致，全文中“只有一句话的段落”上限为5个。）',
    '（必须在末尾输出最新 MVU。严禁复制旧数据或仅做简单更改！强行遍历所有规则清单，根据当前最新互动，对每一个变量进行深度重算。）',
    '（拒绝性格极端化！设定仅为“偏向”而非“绝对”。强制展现人物灰度，在合理情境中自然流露性格的模糊地带与细腻侧面。禁止生硬反转，打破非黑即白，深挖复杂人性的真实底色。）',
  ];

  // 【核心修复】：使用字符串拼接与安全的 RegExp 对象，彻底防止 Markdown 或 HTML 渲染器吞掉注释标签
  const TAG_START = '<' + '!--';
  const TAG_END = '--' + '>';
  const SYS_NOTE_START = TAG_START + '[System Note]\n';
  const VIS_START = TAG_START + 'AIA_VISIBLE_START' + TAG_END;
  const VIS_END = TAG_START + 'AIA_VISIBLE_END' + TAG_END;

  const AIA_STEALTH_BLOCK_REGEX = new RegExp('\\n*<' + '!--\\s*\\[System Note\\][\\s\\S]*?--' + '>', 'g');
  const AIA_VISIBLE_BLOCK_REGEX = new RegExp('\\n*<' + '!--AIA_VISIBLE_START--' + '>[\\s\\S]*?<' + '!--AIA_VISIBLE_END--' + '>', 'g');
  const AIA_LEGACY_DIV_REGEX = new RegExp('\\n*<div class="aia-(stealth|visible)-cmd">\\[System Note:[\\s\\S]*?<\\/div>', 'g');
  const AIA_LEGACY_TAG_REGEX = new RegExp('\\n*<aia-cmd[\\s\\S]*?<\\/aia-cmd>', 'g');

  const state = {
    initialized: false,
    uiMounted: false,
    uiMounting: false,
    interceptBound: false,
    lastCharacterKey: '',
    lastAppendAt: 0,
  };

  function getContext() { return window.SillyTavern?.getContext?.() || null; }
  function isContextReady() {
    const ctx = getContext();
    return !!(ctx?.extensionSettings && typeof ctx.extensionSettings === 'object');
  }

  // 核心：获取并自动修复数据结构
  function getStore() {
    const ctx = getContext();
    if (!ctx || !ctx.extensionSettings) return null;
  
    if (!ctx.extensionSettings[EXT_KEY] || typeof ctx.extensionSettings[EXT_KEY] !== 'object') {
      ctx.extensionSettings[EXT_KEY] = { instructions: [], stealthMode: false, seededDefaults: false };
    }
    const store = ctx.extensionSettings[EXT_KEY];

    // 拍平旧版的预设数据
    if (store.presets) {
      const flat = [];
      for (const [presetName, pData] of Object.entries(store.presets)) {
        for (const inst of (pData.instructions || [])) {
          if (!flat.find(x => x.text === inst.text)) {
            flat.push({
              id: inst.id || `aia_${Date.now()}_${Math.random()}`,
              text: inst.text,
              enabled: inst.enabled !== false,
              isDefault: (presetName === store.defaultPreset),
              boundChars: []
            });
          }
        }
      }
      store.instructions = flat;
      store.stealthMode = store.presets["默认预设"]?.stealthMode || false;
      delete store.presets;
      delete store.activePreset;
      delete store.defaultPreset;
      delete store.characterBindings;
      ctx.saveSettingsDebounced();
    }

    // 补全缺失字段并处理老版本升级兼容性
    if (Array.isArray(store.instructions)) {
      store.instructions.forEach(inst => {
        // 判断是否为老版本升级上来的数据：
        // 1. 没有 boundChars 字段（完全没用过新版）
        // 2. 或者锁链列表为空，且该指令从未被显式标记过“星星”状态
        const isLegacy = inst.boundChars === undefined;
        const noChains = !inst.boundChars || inst.boundChars.length === 0;

        if (isLegacy || (noChains && inst.isDefault === undefined)) {
          // 核心兼容逻辑：为了防止更新后指令失效，默认将老指令设为“星星”（全局默认）
          // 除非该条指令已经有了绑定的锁链
          inst.isDefault = true;
        }

        // 基础字段初始化兜底
        if (inst.enabled === undefined) inst.enabled = true;
        if (inst.isDefault === undefined) inst.isDefault = false;
        if (!Array.isArray(inst.boundChars)) inst.boundChars = [];
      });
    }

    return store;
  }

  function getList() { return getStore()?.instructions || []; }
  
  function saveList(list) {
    const store = getStore();
    if (!store) return;
    store.instructions = list;
    getContext().saveSettingsDebounced();
  }

  function ensureDefaultInstructions() {
    const store = getStore();
    if (!store || store.seededDefaults) return;
    if (store.instructions.length > 0) {
      store.seededDefaults = true;
      getContext().saveSettingsDebounced();
      return;
    }
    store.instructions = DEFAULT_INSTRUCTIONS.map((text, index) => ({
      id: `aia_default_${index + 1}`,
      text,
      enabled: true,    
      isDefault: true,  
      boundChars: []
    }));
    store.seededDefaults = true;
    getContext().saveSettingsDebounced();
  }

  function getCurrentCharacterContext() {
    const ctx = getContext();
    if (!ctx) return { key: "" };

    let targetId = "";

    // 1. 最新版酒馆原生 API：精准抓取单人或群聊
    if (ctx.characterId !== undefined && ctx.characterId !== null) {
      targetId = ctx.characterId;
    } else if (ctx.groupId !== undefined && ctx.groupId !== null) {
      targetId = `group_${ctx.groupId}`;
    } 
    // 2. 老版本全局变量兜底
    else if (typeof window.this_chid !== 'undefined' && window.this_chid !== null) {
      targetId = window.this_chid;
    } 
    // 3. 聊天元数据兜底 (按文件/头像名)
    else if (ctx.chat_metadata) {
      targetId = ctx.chat_metadata.character_id || ctx.chat_metadata.avatar || "";
    }

    targetId = String(targetId).trim();
    return targetId ? { key: `chid:${targetId}` } : { key: "" };
  }

  // 判断某条指令在当前对话中是否生效：总开关打开 && (全局星号 || 绑定的锁链)
  function isInstructionActive(item) {
    if (!item.enabled) return false; 
    const charCtx = getCurrentCharacterContext();
    return item.isDefault || (charCtx.key && item.boundChars.includes(charCtx.key));
  }

  function getEnabledInstructionText() {
    return getList()
      .filter(item => isInstructionActive(item) && item.text.trim())
      .map(item => item.text.trim())
      .join('\n');
  }

  // 核心：注入指令到输入框
  function appendInstructionsToInput() {
    const now = Date.now();
    if (now - state.lastAppendAt < 100) return;

    const $input = $('#send_textarea');
    if (!$input.length) return;

    const userText = String($input.val() || '').trimEnd();
    if (!userText) return;

    const enabledText = getEnabledInstructionText();
    if (!enabledText) return;

    scrubOldInstructions();

    let appendedText = '';
    if (getStore().stealthMode) {
      // 隐身模式：安全拼接 HTML 注释
      appendedText = ` ${SYS_NOTE_START}${enabledText}${TAG_END}`;
    } else {
      // 可见模式：安全拼接块标记
      const formattedText = enabledText.split('\n').join('\n> ');
      appendedText = `\n\n${VIS_START}\n> **[System Note]**\n> ${formattedText}\n${VIS_END}`;
    }

    $input.val(`${userText}${appendedText}`).trigger('input');
    state.lastAppendAt = now;
  }

  // 核心：清洗历史记录中的旧指令
  function scrubOldInstructions() {
    const ctx = getContext();
    if (!Array.isArray(ctx?.chat)) return;

    let didScrub = false;
    for (const message of ctx.chat) {
      if (!message || message.is_user !== true || typeof message.mes !== 'string') continue;
      
      const nextMes = message.mes
        .replace(AIA_STEALTH_BLOCK_REGEX, '')
        .replace(AIA_VISIBLE_BLOCK_REGEX, '')
        .replace(AIA_LEGACY_DIV_REGEX, '')
        .replace(AIA_LEGACY_TAG_REGEX, '');
        
      if (nextMes !== message.mes) {
        message.mes = nextMes;
        didScrub = true;
      }
    }
    
    if (didScrub) {
      window.saveChatDebounced?.();
      $('#chat .aia-stealth-cmd, #chat .aia-visible-cmd, #chat aia-cmd').remove();
    }
  }

  function bindSendInterception() {
    if (state.interceptBound) return;
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('#send_but')) appendInstructionsToInput();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        if (event.target instanceof HTMLElement && event.target.id === 'send_textarea') {
          const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent) || window.innerWidth <= 800;
          if (!isMobile) appendInstructionsToInput();
        }
      }
    }, true);
    state.interceptBound = true;
  }

  // --- UI 构建 ---
  function createInstructionItem(item) {
    const charCtx = getCurrentCharacterContext();
    const charKey = charCtx.key;
    const isBound = charKey && item.boundChars.includes(charKey);

    const $item = $('<div>').addClass('aia-item');
    
    // 左侧：总开关
    const $status = $('<div>').addClass('aia-item-status');
    const $checkbox = $('<input type="checkbox">')
      .prop('checked', item.enabled)
      .css({ cursor: 'pointer', margin: 0, width: '16px', height: '16px' })
      .attr('title', item.enabled ? '已启用' : '已禁用')
      .on('change', () => {
        item.enabled = !item.enabled;
        saveList(getList());
        renderInstructionList();
      });
    $status.append($checkbox);

    // 中间：文字（如果禁用则变暗）
    const $text = $('<div>')
      .addClass('aia-item-text')
      .text(item.text)
      .attr('title', item.text)
      .css('opacity', item.enabled ? '1' : '0.4');

    const $actions = $('<div>').addClass('aia-item-actions');

    // 右侧1：星号 (全局默认)
    const $star = $('<i>')
      .addClass(`fa-star aia-item-icon ${item.isDefault ? 'fa-solid' : 'fa-regular'}`)
      .css('color', item.isDefault ? '#ffeb3b' : '')
      .css('opacity', item.enabled ? '' : '0.3')
      .attr('title', item.isDefault ? '全局默认 (点击取消)' : '设为全局默认')
      .on('click', () => {
        item.isDefault = !item.isDefault;
        saveList(getList());
        renderInstructionList();
      });

    // 右侧2：锁链 (当前角色绑定)
    const $link = $('<i>')
      .addClass(`aia-item-icon ${isBound ? 'fa-solid fa-link' : 'fa-solid fa-link-slash'}`)
      .css('color', isBound ? '#4caf50' : '')
      .css('opacity', item.enabled ? '' : '0.3')
      .attr('title', isBound ? '已绑定此角色 (点击解绑)' : '绑定到此角色')
      .on('click', () => {
        if (!charKey) return window.toastr?.warning?.('未检测到角色，无法绑定');
        if (isBound) item.boundChars = item.boundChars.filter(k => k !== charKey);
        else item.boundChars.push(charKey);
        saveList(getList());
        renderInstructionList();
      });

    // 右侧3 & 4：编辑与删除
    const $editWrap = $('<div class="aia-edit-wrap"></div>');
    const $editInput = $('<textarea class="text_pole aia-edit-input"></textarea>').val(item.text);
    const $btnGroup = $('<div class="aia-edit-btns"></div>');
    const $saveBtn = $('<button class="menu_button aia-btn">保存</button>');
    const $cancelBtn = $('<button class="menu_button aia-btn">取消</button>');

    const $editIcon = $('<i>').addClass('fa-solid fa-pen aia-item-icon').attr('title', '编辑')
      .on('click', () => {
        $text.hide(); $actions.hide();
        $editWrap.css('display', 'flex');
        $editInput.focus();
      });

    const $removeIcon = $('<i>').addClass('fa-solid fa-trash aia-item-icon').attr('title', '删除')
      .on('click', () => {
        saveList(getList().filter(x => x.id !== item.id));
        renderInstructionList();
      });

    $saveBtn.on('click', () => {
      const clean = String($editInput.val() || '').trim();
      if (!clean) return window.toastr?.warning?.('内容不能为空');
      item.text = clean;
      saveList(getList());
      renderInstructionList();
    });

    $cancelBtn.on('click', () => {
      $editInput.val(item.text);
      $editWrap.hide();
      $text.show(); $actions.show();
    });

    $btnGroup.append($cancelBtn, $saveBtn);
    $editWrap.append($editInput, $btnGroup);
    $actions.append($star, $link, $editIcon, $removeIcon);
    return $item.append($status, $text, $editWrap, $actions);
  }

  function renderInstructionList() {
    const $list = $('#aia-list-wrap');
    if (!$list.length) return;
    $list.empty();
    const items = getList();
    if (!items.length) {
      $list.append($('<div class="aia-empty-tip">暂无指令，请在上方添加</div>'));
      return;
    }
    items.forEach(item => $list.append(createInstructionItem(item)));
  }

  function openModal() {
    $('#aia-modal-overlay').show();
    $('#aia-modal').css('display', 'flex');
    renderInstructionList();
    $('#aia-new-instruction').focus();
  }

  function closeModal() {
    $('#aia-modal, #aia-modal-overlay').hide();
  }

  function resolveAssetUrl(fileName) {
  const script = Array.from(document.querySelectorAll('script[src]'))
    // 使用正则模糊匹配：忽略大小写，允许 "auto-instruction" 或 "autoinstruction" 开头的任意文件夹
    .find(node => /\/auto-?instruction.*\/index\.js$/i.test(node.src));
    
  return script?.src ? new URL(fileName, script.src).toString() : fileName;
  }
  
  async function mountUI() {
    if (state.uiMounted || state.uiMounting || !$('#extensionsMenu').length) return;
    state.uiMounting = true;
    try {
      if (!$('#aia-modal').length) {
        // 在 mountUI 函数中，将原先获取 url 和 fetch 的代码替换为：
        const res = await fetch(resolveAssetUrl('index.html'));
        $('body').append($(await res.text()).filter('#aia-modal-overlay, #aia-modal'));
      }
      if (!$('#aia-menu-btn').length) {
        const btn = '<div id="aia-menu-btn" class="list-group-item flex-container flexGap5 interactable"><i class="fa-solid fa-terminal"></i><span>自动指令</span></div>';
        $('#st_ext_manage_button').length ? $('#st_ext_manage_button').before(btn) : $('#extensionsMenu').append(btn);
      }
      $('#aia-menu-btn').off('click').on('click', openModal);
      $('#aia-modal-close, #aia-modal-overlay').off('click').on('click', closeModal);
      $('#aia-add-btn').off('click').on('click', () => {
        const val = $('#aia-new-instruction').val().trim();
        if (!val) return;
        const list = getList();
        list.push({ id: `aia_${Date.now()}`, text: val, enabled: true, isDefault: true, boundChars: [] });
        saveList(list);
        $('#aia-new-instruction').val('').focus();
        renderInstructionList();
      });
      $('#aia-new-instruction').off('keydown').on('keydown', (e) => { if (e.key === 'Enter') $('#aia-add-btn').click(); });
      
      const store = getStore();
      $('#aia-stealth-mode').prop('checked', store.stealthMode).off('change').on('change', function() {
        store.stealthMode = $(this).is(':checked');
        getContext().saveSettingsDebounced();
      });

      $(document).off('keydown.aiaEscape').on('keydown.aiaEscape', (e) => {
        if (e.key === 'Escape' && $('#aia-modal').is(':visible')) closeModal();
      });
      state.uiMounted = true;
    } finally {
      state.uiMounting = false;
    }
  }

  function initPlugin() {
    if (state.initialized || !isContextReady()) return;
    getStore();
    ensureDefaultInstructions();
    bindSendInterception();
    
    window.setInterval(() => {
      if (!$('#extensionsMenu').length) return;
      mountUI();
    }, 300);


    // 每秒检测角色切换，并自动执行指令的勾选/取消逻辑
    window.setInterval(() => {
      const curKey = getCurrentCharacterContext().key;
      if (curKey !== state.lastCharacterKey) {
        state.lastCharacterKey = curKey;
        
        const list = getList();
        let stateChanged = false;

        list.forEach(item => {
          // 规则 3: 选择默认(星号)的指令不受切换影响，完全由用户手动控制开关
          if (item.isDefault) return;

          // 检查该指令是否绑定了当前新切入的角色
          const isBoundToCurrent = curKey && item.boundChars.includes(curKey);

          if (isBoundToCurrent && !item.enabled) {
            // 规则 2: 进入绑定角色，自动开启勾选
            item.enabled = true;
            stateChanged = true;
          } else if (!isBoundToCurrent && item.enabled) {
            // 规则 1: 退出绑定角色(进入未绑定角色)，自动关闭勾选
            item.enabled = false;
            stateChanged = true;
          }
        });

        // 如果状态有自动变更，保存并刷新界面
        if (stateChanged) {
          saveList(list);
        }
        if ($('#aia-modal').is(':visible')) renderInstructionList();
      }
    }, 1000);
    
    state.initialized = true;
  }

  if (window.eventSource && window.event_types?.APP_READY) {
    window.eventSource.on(window.event_types.APP_READY, initPlugin);
  }
  window.setInterval(() => { if (!state.initialized && isContextReady()) initPlugin(); }, 300);
})();
