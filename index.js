(function () {
  const EXT_KEY = 'auto_instruction_appender';
  const DEFAULT_INSTRUCTIONS = [
    '（仅针对 <content></content> 标签内的内容生效：请生成2500字以上的长文。要求合并细碎段落，保持长短段错落有致，全文中“只有一句话的段落”上限为5个。）',
    '（必须在末尾输出最新 MVU。严禁复制旧数据或仅做简单更改！强行遍历所有规则清单，根据当前最新互动，对每一个变量进行深度重算。）',
    '（拒绝性格极端化！设定仅为“偏向”而非“绝对”。强制展现人物灰度，在合理情境中自然流露性格的模糊地带与细腻侧面。禁止生硬反转，打破非黑即白，深挖复杂人性的真实底色。）',
  ];
  const AIA_STEALTH_BLOCK_REGEX = /\n*<!--\s*\[System Note\][\s\S]*?-->/g;
  const AIA_VISIBLE_BLOCK_REGEX = /\n*<!--AIA_VISIBLE_START-->[\s\S]*?<!--AIA_VISIBLE_END-->/g;
  const AIA_LEGACY_DIV_REGEX = /\n*<div class="aia-(stealth|visible)-cmd">\[System Note:[\s\S]*?<\/div>/g;
  const AIA_LEGACY_TAG_REGEX = /\n*<aia-cmd[\s\S]*?<\/aia-cmd>/g;

  const state = {
    initialized: false,
    uiMounted: false,
    uiMounting: false,
    interceptBound: false,
    menuPoller: null,
    bootstrapPoller: null,
    lastAppendAt: 0,
  };

  function getContext() {
    return window.SillyTavern?.getContext?.() || null;
  }

  function isContextReady() {
    const ctx = getContext();
    if (!ctx) return false;
    const settings = ctx.extensionSettings;
    return !!(settings && typeof settings === 'object' && Object.keys(settings).length > 0);
  }

  function getStore() {
    const ctx = getContext();
    if (!ctx || !ctx.extensionSettings) return null;

    if (!ctx.extensionSettings[EXT_KEY] || typeof ctx.extensionSettings[EXT_KEY] !== 'object') {
      ctx.extensionSettings[EXT_KEY] = { instructions: [], stealthMode: false, seededDefaults: false };
    }

    const store = ctx.extensionSettings[EXT_KEY];
    if (!Array.isArray(store.instructions)) store.instructions = [];
    if (typeof store.stealthMode !== 'boolean') store.stealthMode = false;
    if (typeof store.seededDefaults !== 'boolean') store.seededDefaults = false;

    return store;
  }

  function saveStore() {
    const ctx = getContext();
    if (!ctx) return;
    ctx.saveSettingsDebounced();
  }

  function getList() {
    const store = getStore();
    return store ? store.instructions : [];
  }

  function saveList(list) {
    const store = getStore();
    if (!store) return;
    store.instructions = list;
    saveStore();
  }

  function ensureDefaultInstructions() {
    const store = getStore();
    if (!store) return;
    if (store.seededDefaults) return;
    if (store.instructions.length > 0) {
      store.seededDefaults = true;
      saveStore();
      return;
    }

    store.instructions = DEFAULT_INSTRUCTIONS.map((text, index) => ({
      id: `aia_default_${index + 1}`,
      text,
      enabled: true,
    }));
    store.seededDefaults = true;
    saveStore();
  }

  function isStealthModeEnabled() {
    const store = getStore();
    return Boolean(store?.stealthMode);
  }

  function setStealthMode(enabled) {
    const store = getStore();
    if (!store) return;
    store.stealthMode = Boolean(enabled);
    saveStore();
  }

  function syncStealthPrompt() {
    const $stealthToggle = $('#aia-stealth-mode');
    if (!$stealthToggle.length) return;
    $stealthToggle.prop('checked', isStealthModeEnabled());
  }

  function getEnabledInstructionText() {
    return getList()
      .filter(item => item.enabled && item.text.trim())
      .map(item => item.text.trim())
      .join('\n');
  }

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
    if (isStealthModeEnabled()) {
      const stealthText = `\n\n<!--[System Note]\n${enabledText}-->`;
      appendedText = stealthText;
    } else {
      const formattedText = enabledText.split('\n').join('\n> ');
      appendedText = `\n\n<!--AIA_VISIBLE_START-->\n> **[System Note]**\n> ${formattedText}\n<!--AIA_VISIBLE_END-->`;
    }

    $input.val(`${userText}${appendedText}`).trigger('input');
    state.lastAppendAt = now;
  }

  function scrubOldInstructions() {
    const ctx = getContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return;
    const scrubRegex = /\n*<!--\s*\[System Note\][\s\S]*?-->/g;

    let didScrub = false;
    for (const message of chat) {
      if (!message || message.is_user !== true || typeof message.mes !== 'string') continue;
      const nextMes = message.mes
        .replace(scrubRegex, '')
        .replace(AIA_STEALTH_BLOCK_REGEX, '')
        .replace(AIA_VISIBLE_BLOCK_REGEX, '')
        .replace(AIA_LEGACY_DIV_REGEX, '')
        .replace(AIA_LEGACY_TAG_REGEX, '');
      if (nextMes !== message.mes) {
        message.mes = nextMes;
        didScrub = true;
      }
    }

    if (!didScrub) return;

    window.saveChatDebounced?.();
    $('#chat .aia-stealth-cmd, #chat .aia-visible-cmd, #chat aia-cmd').remove();
  }

  function bindSendInterception() {
    if (state.interceptBound) return;

    // 1. 监听发送按钮点击 (兼容多端)
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('#send_but')) {
        appendInstructionsToInput();
      }
    }, true);

    // 2. 监听回车键 (仅限非移动端)
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        if (event.target instanceof HTMLElement && event.target.id === 'send_textarea') {
          // 检测是否为移动设备或小屏幕
          const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent) || window.innerWidth <= 800;
          
          if (!isMobile) {
            appendInstructionsToInput();
          }
        }
      }
    }, true);

    state.interceptBound = true;
  }

  function resolveAssetUrl(fileName) {
    const script = Array.from(document.querySelectorAll('script[src]'))
      .find(node => node.src.includes('/AutoInstruction/index.js') || node.src.includes('/AutoInstructionAppender/index.js'));
    if (script?.src) return new URL(fileName, script.src).toString();
    return fileName;
  }

  async function ensureModalTemplate() {
    if ($('#aia-modal').length && $('#aia-modal-overlay').length) return true;

    const templateUrl = resolveAssetUrl('index.html');
    const response = await fetch(templateUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Failed to load template: ${response.status}`);

    const templateHtml = await response.text();
    const $templateRoot = $('<div>').html(templateHtml);
    const $overlay = $templateRoot.find('#aia-modal-overlay').first();
    const $modal = $templateRoot.find('#aia-modal').first();
    if (!$overlay.length || !$modal.length) throw new Error('Template missing modal nodes');

    $('body').append($overlay, $modal);
    return true;
  }

  function createInstructionItem(item) {
    const $item = $('<div>').addClass('aia-item');
    const $toggle = $('<input type="checkbox">')
      .prop('checked', Boolean(item.enabled))
      .on('change', function () {
        const list = getList();
        const target = list.find(x => x.id === item.id);
        if (!target) return;
        target.enabled = $(this).is(':checked');
        saveList(list);
      });

    const $text = $('<div>').addClass('aia-item-text').text(item.text).attr('title', item.text);
    const $actions = $('<div>').addClass('aia-item-actions');
    const $editWrap = $('<div class="aia-edit-wrap"></div>');
    const $editInput = $('<input type="text" class="text_pole aia-edit-input">').val(item.text);
    const $saveBtn = $('<button class="menu_button aia-btn aia-inline-btn">保存</button>');
    const $cancelBtn = $('<button class="menu_button aia-btn aia-inline-btn">取消</button>');

    const $editIcon = $('<i>')
      .addClass('fa-solid fa-pen aia-item-icon')
      .attr('title', '编辑')
      .on('click', () => {
        $text.hide();
        $actions.hide();
        $editWrap.css('display', 'flex');
        $editInput.focus();
      });

    const $removeIcon = $('<i>')
      .addClass('fa-solid fa-trash aia-item-icon')
      .attr('title', '删除')
      .on('click', () => {
        saveList(getList().filter(x => x.id !== item.id));
        renderInstructionList();
      });

    $saveBtn.on('click', () => {
      const clean = String($editInput.val() || '').trim();
      if (!clean) return window.toastr?.warning?.('内容不能为空');
      const list = getList();
      const target = list.find(x => x.id === item.id);
      if (!target) return;
      target.text = clean;
      saveList(list);
      renderInstructionList();
    });

    $cancelBtn.on('click', () => {
      $editInput.val(item.text);
      $editWrap.hide();
      $text.show();
      $actions.show();
    });

    $editWrap.append($editInput, $saveBtn, $cancelBtn);
    $actions.append($editIcon, $removeIcon);
    return $item.append($toggle, $text, $editWrap, $actions);
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

  function handleAddInstruction() {
    const $input = $('#aia-new-instruction');
    const clean = String($input.val() || '').trim();
    if (!clean) return window.toastr?.warning?.('指令内容不能为空');

    const list = getList();
    list.push({ id: `aia_${Date.now()}`, text: clean, enabled: true });
    saveList(list);

    $input.val('');
    renderInstructionList();
    $input.focus();
  }

  async function mountUI() {
    if (state.uiMounted || state.uiMounting || !$('#extensionsMenu').length) return;
    state.uiMounting = true;

    try {
      await ensureModalTemplate();

      if (!$('#aia-menu-btn').length) {
        const menuBtn = '<div id="aia-menu-btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><i class="fa-solid fa-terminal"></i><span>自动指令</span></div>';
        if ($('#st_ext_manage_button').length) {
          $('#st_ext_manage_button').before(menuBtn);
        } else {
          $('#extensionsMenu').append(menuBtn);
        }
      }

      $('#aia-menu-btn').off('click').on('click', openModal);
      $('#aia-modal-close, #aia-modal-overlay').off('click').on('click', closeModal);
      $('#aia-add-btn').off('click').on('click', handleAddInstruction);
      $('#aia-new-instruction').off('keydown').on('keydown', (e) => { if (e.key === 'Enter') handleAddInstruction(); });
      $('#aia-stealth-mode')
        .prop('checked', isStealthModeEnabled())
        .off('change')
        .on('change', function () { setStealthMode($(this).is(':checked')); });

      $(document).off('keydown.aiaEscape').on('keydown.aiaEscape', (e) => {
        if (e.key === 'Escape' && $('#aia-modal').is(':visible')) closeModal();
      });

      state.uiMounted = true;
    } catch (error) {
      console.error('[Auto-Instruction-Appender] mount UI failed', error);
    } finally {
      state.uiMounting = false;
    }
  }

  function startMenuMountPolling() {
    if (state.menuPoller) return;

    state.menuPoller = window.setInterval(() => {
      if (!state.initialized) return;
      if (!$('#extensionsMenu').length) return;
      void mountUI();
      if (state.uiMounted) {
        window.clearInterval(state.menuPoller);
        state.menuPoller = null;
      }
    }, 300);
  }

  function initPlugin() {
    if (state.initialized) return;
    if (!isContextReady()) return;

    getStore();
    ensureDefaultInstructions();
    bindSendInterception();
    startMenuMountPolling();
    syncStealthPrompt();

    state.initialized = true;
    console.log('[Auto-Instruction-Appender] initialized with SillyTavern context');
  }

  function bootstrap() {
    if (window.eventSource && window.event_types?.APP_READY) {
      window.eventSource.on(window.event_types.APP_READY, initPlugin);
    }

    state.bootstrapPoller = window.setInterval(() => {
      if (state.initialized) {
        window.clearInterval(state.bootstrapPoller);
        state.bootstrapPoller = null;
        return;
      }
      if (isContextReady()) {
        initPlugin();
      }
    }, 300);
  }

  bootstrap();
})();
