// Streaming Handbrake
// Watches streaming AI generation for user-defined trigger phrases/regexes and
// pulls the handbrake (stops generation) the moment one is seen.

const MODULE_NAME = 'streaming_handbrake';

const defaultSettings = Object.freeze({
    enabled: true,
    notify: true,
    trimMatch: true,
    // Minimum time (ms) between checks, to avoid hammering regex tests on every
    // single token during very fast streams. 0 = check every token.
    checkThrottleMs: 0,
    triggers: [
        { id: 'default-1', label: 'AI disclaimer slop', pattern: 'as an ai language model', isRegex: false, caseSensitive: false, enabled: true },
        { id: 'default-2', label: 'Refusal boilerplate', pattern: "i cannot fulfill this request", isRegex: false, caseSensitive: false, enabled: true },
        { id: 'default-3', label: 'Repeated ellipsis (example regex)', pattern: '(\\.\\s*){6,}', isRegex: true, caseSensitive: false, enabled: false },
    ],
});

function uid() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return `t-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function getSettings() {
    const context = SillyTavern.getContext();
    const { extensionSettings } = context;

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = extensionSettings[MODULE_NAME];

    // Backfill any missing top-level keys (helps after updates)
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = structuredClone(defaultSettings[key]);
        }
    }
    if (!Array.isArray(settings.triggers)) {
        settings.triggers = structuredClone(defaultSettings.triggers);
    }

    return settings;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function extractStreamedText(eventData) {
    // The exact shape of STREAM_TOKEN_RECEIVED's payload isn't guaranteed across
    // ST versions, so we handle the common shapes defensively.
    if (typeof eventData === 'string') return eventData;
    if (eventData && typeof eventData === 'object') {
        if (typeof eventData.text === 'string') return eventData.text;
        if (typeof eventData.mes === 'string') return eventData.mes;
    }
    // Fallback: read the message currently being streamed into the chat array.
    try {
        const { chat } = SillyTavern.getContext();
        return chat?.[chat.length - 1]?.mes ?? '';
    } catch {
        return '';
    }
}

/**
 * Tests a single trigger against the text.
 * @returns {{ index: number, matchText: string } | null}
 */
function testTrigger(text, trigger) {
    if (!trigger.enabled || !trigger.pattern) return null;

    try {
        if (trigger.isRegex) {
            const flags = trigger.caseSensitive ? '' : 'i';
            const re = new RegExp(trigger.pattern, flags);
            const m = re.exec(text);
            return m ? { index: m.index, matchText: m[0] } : null;
        }

        const haystack = trigger.caseSensitive ? text : text.toLowerCase();
        const needle = trigger.caseSensitive ? trigger.pattern : trigger.pattern.toLowerCase();
        const idx = haystack.indexOf(needle);
        return idx === -1 ? null : { index: idx, matchText: trigger.pattern };
    } catch (e) {
        console.error(`[${MODULE_NAME}] Invalid trigger pattern, skipping:`, trigger, e);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function truncateCurrentMessage(newText) {
    try {
        const { chat } = SillyTavern.getContext();
        const lastMes = chat?.[chat.length - 1];
        if (lastMes) {
            lastMes.mes = newText;
        }

        // Best-effort immediate visual feedback while the stop takes effect.
        const mesBlocks = document.querySelectorAll('#chat .mes');
        const lastBlock = mesBlocks[mesBlocks.length - 1];
        const textEl = lastBlock?.querySelector('.mes_text');
        if (textEl) {
            textEl.textContent = newText;
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] Failed to truncate in-progress message:`, e);
    }
}

function pullHandbrake() {
    // Best-effort: click the visible stop-generation button.
    const stopBtn = document.getElementById('mes_stop');
    if (stopBtn && stopBtn.offsetParent !== null) {
        stopBtn.click();
        return;
    }

    // Fallback: ST binds Escape to interrupt an in-progress generation.
    document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
    }));
}

// Once a trigger fires, ST's own streaming renderer keeps re-writing the
// message from its internal buffer on every subsequent token — and does one
// more full write when it finalizes the message after stop takes effect. A
// single truncation gets overwritten by that. So instead of truncating once,
// we keep re-asserting the truncated text on every following tick (and on the
// relevant lifecycle events) until the generation is fully, truly done.
let handbrakeState = null; // { truncatedText: string } | null

function handleTrigger(trigger, text, match) {
    const settings = getSettings();
    const truncatedText = text.slice(0, match.index);

    console.log(`[${MODULE_NAME}] Trigger "${trigger.label || trigger.pattern}" matched at index ${match.index}. Pulling the handbrake.`);

    if (settings.trimMatch) {
        handbrakeState = { truncatedText };
        truncateCurrentMessage(truncatedText);
    }

    if (settings.notify && typeof toastr !== 'undefined') {
        toastr.warning(`Stopped generation: "${trigger.label || trigger.pattern}"`, 'Streaming Handbrake');
    }

    pullHandbrake();
}

function reassertTruncation() {
    if (!handbrakeState) return;
    if (getSettings().trimMatch) {
        truncateCurrentMessage(handbrakeState.truncatedText);
    }
}

function finalizeHandbrake() {
    if (!handbrakeState) return;
    reassertTruncation();
    handbrakeState = null;
}

let lastCheckTime = 0;

function onStreamToken(eventData) {
    // Already pulled the brake this generation: stop looking for new
    // triggers, just keep fighting ST's re-renders until it actually stops.
    if (handbrakeState) {
        reassertTruncation();
        return;
    }

    const settings = getSettings();
    if (!settings.enabled) return;

    if (settings.checkThrottleMs > 0) {
        const now = Date.now();
        if (now - lastCheckTime < settings.checkThrottleMs) return;
        lastCheckTime = now;
    }

    const text = extractStreamedText(eventData);
    if (!text) return;

    for (const trigger of settings.triggers) {
        const match = testTrigger(text, trigger);
        if (match) {
            handleTrigger(trigger, text, match);
            return; // one handbrake pull per generation is enough
        }
    }
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function triggerRowHtml(trigger) {
    return `
    <div class="handbrake-trigger-row" data-id="${trigger.id}">
        <input type="checkbox" class="handbrake-trigger-enabled" title="Enabled" ${trigger.enabled ? 'checked' : ''} />
        <input type="text" class="text_pole handbrake-trigger-label" placeholder="Label (optional)" value="${escapeAttr(trigger.label || '')}" />
        <input type="text" class="text_pole handbrake-trigger-pattern" placeholder="Phrase or regex..." value="${escapeAttr(trigger.pattern || '')}" />
        <label class="checkbox_label" title="Treat pattern as a regular expression">
            <input type="checkbox" class="handbrake-trigger-regex" ${trigger.isRegex ? 'checked' : ''} /> regex
        </label>
        <label class="checkbox_label" title="Case sensitive matching">
            <input type="checkbox" class="handbrake-trigger-case" ${trigger.caseSensitive ? 'checked' : ''} /> Aa
        </label>
        <div class="menu_button handbrake-trigger-delete" title="Delete trigger">
            <i class="fa-solid fa-trash"></i>
        </div>
    </div>`;
}

function escapeAttr(str) {
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function renderTriggerList() {
    const settings = getSettings();
    const $list = $('#handbrake_trigger_list');
    $list.empty();
    for (const trigger of settings.triggers) {
        $list.append(triggerRowHtml(trigger));
    }
}

function bindSettingsEvents() {
    const settings = getSettings();

    $('#handbrake_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettings();
    });

    $('#handbrake_notify').prop('checked', settings.notify).on('change', function () {
        settings.notify = $(this).prop('checked');
        saveSettings();
    });

    $('#handbrake_trim').prop('checked', settings.trimMatch).on('change', function () {
        settings.trimMatch = $(this).prop('checked');
        saveSettings();
    });

    $('#handbrake_add_trigger').on('click', function () {
        settings.triggers.push({
            id: uid(),
            label: '',
            pattern: '',
            isRegex: false,
            caseSensitive: false,
            enabled: true,
        });
        saveSettings();
        renderTriggerList();
    });

    // Delegated events for dynamically-added rows
    $('#handbrake_trigger_list')
        .on('click', '.handbrake-trigger-delete', function () {
            const id = $(this).closest('.handbrake-trigger-row').data('id');
            settings.triggers = settings.triggers.filter(t => t.id !== id);
            saveSettings();
            renderTriggerList();
        })
        .on('change input', '.handbrake-trigger-enabled, .handbrake-trigger-label, .handbrake-trigger-pattern, .handbrake-trigger-regex, .handbrake-trigger-case', function () {
            const $row = $(this).closest('.handbrake-trigger-row');
            const id = $row.data('id');
            const trigger = settings.triggers.find(t => t.id === id);
            if (!trigger) return;

            trigger.enabled = $row.find('.handbrake-trigger-enabled').prop('checked');
            trigger.label = $row.find('.handbrake-trigger-label').val();
            trigger.pattern = $row.find('.handbrake-trigger-pattern').val();
            trigger.isRegex = $row.find('.handbrake-trigger-regex').prop('checked');
            trigger.caseSensitive = $row.find('.handbrake-trigger-case').prop('checked');
            saveSettings();
        });

    renderTriggerList();
}

function buildSettingsPanel() {
    const html = `
    <div id="handbrake_settings" class="handbrake-extension-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Streaming Handbrake</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="handbrake_enabled" type="checkbox" />
                    Enabled
                </label>
                <label class="checkbox_label">
                    <input id="handbrake_notify" type="checkbox" />
                    Show a toast when the handbrake is pulled
                </label>
                <label class="checkbox_label">
                    <input id="handbrake_trim" type="checkbox" />
                    Trim the offending text from the message before stopping
                </label>

                <hr>
                <b>Triggers</b>
                <div class="handbrake-hint">
                    Phrase matches are case-insensitive substrings by default. Check "regex" to use a JS regular expression instead.
                </div>
                <div id="handbrake_trigger_list"></div>
                <div id="handbrake_add_trigger" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-plus"></i> Add trigger
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    bindSettingsEvents();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();

    getSettings(); // ensure defaults exist and are persisted
    buildSettingsPanel();

    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);

    // These fire around/after the stop actually taking effect, and ST does
    // its own write of the finalized message text at these points — so we
    // need to re-assert the truncation there too, then release the state.
    eventSource.on(event_types.MESSAGE_RECEIVED, reassertTruncation);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, reassertTruncation);
    eventSource.on(event_types.GENERATION_STOPPED, finalizeHandbrake);
    eventSource.on(event_types.GENERATION_ENDED, finalizeHandbrake);

    console.log(`[${MODULE_NAME}] Loaded.`);
});
