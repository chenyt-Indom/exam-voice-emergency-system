/**
 * 考勤应急语音系统 - 前端主逻辑
 * 功能：时间段管理、音频库CRUD、拖拽交互、播放控制
 */

// ==================== 全局状态 ====================
const STATE = {
    slots: [],              // 时间段列表 [{id, audio: filename|null, time: "HH:MM"}]
    audioFiles: [],         // 本地音频文件列表
    currentPlaying: null,   // 当前播放的 slot id
    maxSlots: 10,           // 最多时间段数
    nextSlotId: 1,          // 自增ID
    pendingDelete: null,    // 待删除的文件名
    pendingRename: null,    // 待重命名的文件原名
    dragData: null,         // 拖拽数据 {type:'audio'|'slot', filename?, slotId?}
    scheduleEnabled: false, // 定时播报开关
    outputDeviceId: "",     // 音频输出设备ID
    scheduleTimer: null,    // 定时器句柄
    playedToday: new Set(), // 今天已触发过的 slot ID（避免重复播放）
    lastCheckMinute: "",    // 上次检查的分钟（防止同一分钟多次触发）
    audioDevices: [],       // 可用音频输出设备列表
};

// 序号映射
const NUM_MAP = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
    startClock();
    setupUploadDragDrop();
    await refreshDevices();
    await loadConfig();
    await refreshLibrary();
    renderSlots();
    updateScheduleUI();
});

// ==================== 时钟 ====================
function startClock() {
    const update = () => {
        const now = new Date();
        const str = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + ' ' +
            String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0') + ':' +
            String(now.getSeconds()).padStart(2, '0');
        document.getElementById('headerTime').textContent = str;
    };
    update();
    setInterval(update, 1000);
}

// ==================== 配置加载/保存 ====================
async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        if (data.success && data.config) {
            const cfg = data.config;
            if (cfg.slots && cfg.slots.length > 0) {
                STATE.slots = cfg.slots.map(s => ({
                    id: s.id,
                    audio: s.audio || null,
                    time: s.time || '',
                }));
                STATE.nextSlotId = Math.max(...STATE.slots.map(s => s.id), 0) + 1;
            } else {
                STATE.slots = [{ id: STATE.nextSlotId++, audio: null, time: '' }];
            }
            STATE.scheduleEnabled = cfg.schedule_enabled || false;
            STATE.outputDeviceId = cfg.output_device_id || '';
        } else {
            STATE.slots = [{ id: STATE.nextSlotId++, audio: null, time: '' }];
            STATE.scheduleEnabled = false;
            STATE.outputDeviceId = '';
        }
    } catch (e) {
        STATE.slots = [{ id: STATE.nextSlotId++, audio: null, time: '' }];
        STATE.scheduleEnabled = false;
        STATE.outputDeviceId = '';
    }
}

async function saveConfig() {
    try {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                slots: STATE.slots,
                schedule_enabled: STATE.scheduleEnabled,
                output_device_id: STATE.outputDeviceId,
            })
        });
    } catch (e) {
        console.error('保存配置失败:', e);
    }
}

// ==================== 音频库 ====================
async function refreshLibrary() {
    try {
        const res = await fetch('/api/audio-files');
        const data = await res.json();
        if (data.success) {
            STATE.audioFiles = data.files;
            renderLibrary();
        }
    } catch (e) {
        showToast('无法连接本地服务，请确保服务已启动', 'error');
    }
}

function renderLibrary() {
    const container = document.getElementById('audioList');
    const countEl = document.getElementById('libraryCount');

    countEl.textContent = STATE.audioFiles.length + ' 个音频';

    if (STATE.audioFiles.length === 0) {
        container.innerHTML = '<div class="no-audio">暂无音频文件，请上传或放入 audio/ 文件夹</div>';
        return;
    }

    container.innerHTML = STATE.audioFiles.map(f => `
        <div class="audio-item"
             draggable="true"
             ondragstart="onAudioDragStart(event, '${escapeHtml(f.name)}')"
             ondragend="onDragEnd(event)">
            <span class="audio-item-icon">🎵</span>
            <div class="audio-item-info" onclick="previewAudio('${escapeHtml(f.name)}')" title="点击试听">
                <div class="audio-item-name">${escapeHtml(f.name)}</div>
                <div class="audio-item-meta">${f.size_display} · ${f.modified}</div>
            </div>
            <div class="audio-item-actions">
                <button class="btn-icon" title="添加到时间段" onclick="addToSlot('${escapeHtml(f.name)}')">+</button>
                <button class="btn-icon" title="重命名" onclick="openRenameModal('${escapeHtml(f.name)}')">✎</button>
                <button class="btn-icon delete" title="删除" onclick="openDeleteModal('${escapeHtml(f.name)}')">✕</button>
            </div>
        </div>
    `).join('');
}

async function previewAudio(filename) {
    const player = document.getElementById('audioPlayer');
    player.src = `/api/audio/${encodeURIComponent(filename)}`;
    player.currentTime = 0;
    try {
        await player.play();
        // 3秒后停止
        setTimeout(() => {
            if (player.src.includes(encodeURIComponent(filename))) {
                player.pause();
            }
        }, 3000);
        showToast('试听: ' + filename + ' (3秒预览)');
    } catch (e) {
        showToast('播放失败: ' + e.message, 'error');
    }
}

// ==================== 上传 ====================
function setupUploadDragDrop() {
    const zone = document.getElementById('uploadZone');

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', () => {
        zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            await uploadFiles(files);
        }
    });
}

async function handleFileSelect(event) {
    const files = event.target.files;
    if (files.length > 0) {
        await uploadFiles(files);
    }
    event.target.value = '';
}

async function uploadFiles(files) {
    const formData = new FormData();
    for (const f of files) {
        formData.append('files', f);
    }

    showToast('正在上传...');

    try {
        const res = await fetch('/api/multi-upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            showToast('成功上传 ' + data.uploaded.length + ' 个文件', 'success');
            await refreshLibrary();
        } else {
            showToast('上传失败: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('上传失败: ' + e.message, 'error');
    }
}

// ==================== 音频文件 CRUD ====================
async function openAudioFolder() {
    try {
        await fetch('/api/open-folder');
    } catch (e) {
        showToast('无法打开文件夹', 'error');
    }
}

function openRenameModal(filename) {
    STATE.pendingRename = filename;
    const input = document.getElementById('renameInput');
    input.value = filename;
    document.getElementById('renameModal').classList.add('show');
    setTimeout(() => input.focus(), 100);
}

function closeRenameModal() {
    document.getElementById('renameModal').classList.remove('show');
    STATE.pendingRename = null;
}

async function confirmRename() {
    const newName = document.getElementById('renameInput').value.trim();
    if (!newName || newName === STATE.pendingRename) {
        closeRenameModal();
        return;
    }

    try {
        const res = await fetch(`/api/audio-files/${encodeURIComponent(STATE.pendingRename)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_name: newName })
        });
        const data = await res.json();
        if (data.success) {
            // 更新所有引用了旧名称的 slot
            STATE.slots.forEach(s => {
                if (s.audio === STATE.pendingRename) {
                    s.audio = data.new_name;
                }
            });
            await saveConfig();
            renderSlots();
            showToast('重命名成功', 'success');
        } else {
            showToast('重命名失败: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('重命名失败: ' + e.message, 'error');
    }

    closeRenameModal();
    await refreshLibrary();
}

function openDeleteModal(filename) {
    STATE.pendingDelete = filename;
    document.getElementById('deleteMsg').textContent =
        '确定要删除 "' + filename + '" 吗？此操作不可恢复。';
    document.getElementById('deleteModal').classList.add('show');
}

function closeDeleteModal() {
    document.getElementById('deleteModal').classList.remove('show');
    STATE.pendingDelete = null;
}

async function confirmDelete() {
    if (!STATE.pendingDelete) return;

    try {
        const res = await fetch(`/api/audio-files/${encodeURIComponent(STATE.pendingDelete)}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
            // 清除引用了该文件的 slot
            STATE.slots.forEach(s => {
                if (s.audio === STATE.pendingDelete) {
                    s.audio = null;
                }
            });
            await saveConfig();
            renderSlots();
            showToast('已删除', 'success');
        } else {
            showToast('删除失败: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('删除失败: ' + e.message, 'error');
    }

    closeDeleteModal();
    await refreshLibrary();
}

// ==================== 时间段管理 ====================
function addSlot(audioFilename = null) {
    if (STATE.slots.length >= STATE.maxSlots) {
        showToast('最多只能有 ' + STATE.maxSlots + ' 个时间段', 'error');
        return;
    }
    STATE.slots.push({ id: STATE.nextSlotId++, audio: audioFilename, time: '' });
    saveConfig();
    renderSlots();
}

function removeSlot(slotId) {
    if (STATE.slots.length <= 1) {
        showToast('至少保留一个时间段', 'error');
        return;
    }
    // 停止该 slot 的播放
    if (STATE.currentPlaying === slotId) {
        stopAllAudio();
    }
    STATE.slots = STATE.slots.filter(s => s.id !== slotId);
    saveConfig();
    renderSlots();
}

function addToSlot(filename) {
    addSlot(filename);
    showToast('已添加时间段: ' + filename, 'success');
}

function renderSlots() {
    const container = document.getElementById('slotsList');
    const countEl = document.getElementById('slotCount');

    countEl.textContent = '共 ' + STATE.slots.length + ' 个时间段';

    container.innerHTML = STATE.slots.map((slot, index) => {
        const num = NUM_MAP[index] || (index + 1);
        const isPlaying = STATE.currentPlaying === slot.id;
        const hasAudio = slot.audio && slot.audio.trim() !== '';
        const timeVal = slot.time || '';

        return `
            <div class="slot-item ${isPlaying ? 'playing' : ''}"
                 id="slot-${slot.id}"
                 draggable="true"
                 ondragstart="onSlotDragStart(event, ${slot.id})"
                 ondragover="onSlotDragOver(event, ${slot.id})"
                 ondragleave="onSlotDragLeave(event, ${slot.id})"
                 ondrop="onSlotDrop(event, ${slot.id})"
                 ondragend="onDragEnd(event)">
                <span class="slot-number">${num}</span>
                <div class="slot-content">
                    <div class="slot-drop-zone ${hasAudio ? 'has-audio' : ''}"
                         ondragover="onDropZoneDragOver(event)"
                         ondragleave="onDropZoneDragLeave(event)"
                         ondrop="onDropZoneDrop(event, ${slot.id})"
                         onclick="onDropZoneClick(${slot.id})">
                        ${hasAudio ? '🎵 ' + escapeHtml(slot.audio) : '拖入音频到此处，或点击选择'}
                    </div>
                    <input type="time" class="slot-time-input"
                           value="${escapeHtml(timeVal)}"
                           onchange="onSlotTimeChange(${slot.id}, this.value)"
                           onclick="event.stopPropagation()"
                           title="设置定时播报时间（仅时间，不含日期）"
                           placeholder="--:--">
                </div>
                <div class="slot-actions">
                    <button class="btn-play ${isPlaying ? 'playing' : ''}"
                            ${hasAudio ? '' : 'disabled'}
                            onclick="togglePlaySlot(${slot.id})"
                            title="${isPlaying ? '停止' : '播放'}">
                        ${isPlaying ? '■' : '▶'}
                    </button>
                    <button class="btn-delete-slot"
                            onclick="removeSlot(${slot.id})"
                            title="删除此时间段">×</button>
                </div>
            </div>
        `;
    }).join('');
}

// ==================== 播放控制 ====================
async function togglePlaySlot(slotId) {
    const slot = STATE.slots.find(s => s.id === slotId);
    if (!slot || !slot.audio) return;

    const player = document.getElementById('audioPlayer');

    // 如果正在播放同一个 slot，则停止
    if (STATE.currentPlaying === slotId) {
        player.pause();
        player.currentTime = 0;
        STATE.currentPlaying = null;
        updatePlayingUI();
        setStatus('已停止');
        return;
    }

    // 停止当前播放
    player.pause();
    player.currentTime = 0;

    // 播放新的
    player.src = `/api/audio/${encodeURIComponent(slot.audio)}`;
    try {
        await player.play();
        STATE.currentPlaying = slotId;
        updatePlayingUI();
        setStatus('正在播放: ' + slot.audio);
        document.getElementById('btnStopAll').disabled = false;
    } catch (e) {
        showToast('播放失败: ' + e.message, 'error');
        STATE.currentPlaying = null;
        updatePlayingUI();
    }
}

function stopAllAudio() {
    const player = document.getElementById('audioPlayer');
    player.pause();
    player.currentTime = 0;
    STATE.currentPlaying = null;
    updatePlayingUI();
    setStatus('已停止');
    document.getElementById('btnStopAll').disabled = true;
}

function onAudioEnded() {
    STATE.currentPlaying = null;
    updatePlayingUI();
    setStatus('播放完毕');
    document.getElementById('btnStopAll').disabled = true;
}

function onAudioError() {
    const player = document.getElementById('audioPlayer');
    showToast('音频加载失败: ' + (player.error ? player.error.message : '未知错误'), 'error');
    STATE.currentPlaying = null;
    updatePlayingUI();
    document.getElementById('btnStopAll').disabled = true;
}

function updatePlayingUI() {
    renderSlots();
    document.getElementById('btnStopAll').disabled = (STATE.currentPlaying === null);
}

function setStatus(text) {
    document.getElementById('statusText').textContent = text;
}

// ==================== 拖拽 - 音频库到时间段 ====================
function onAudioDragStart(event, filename) {
    STATE.dragData = { type: 'audio', filename: filename };
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', filename);
    // 标记拖拽中的元素
    event.target.closest('.audio-item')?.classList.add('dragging');
}

function onDropZoneDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    event.target.closest('.slot-drop-zone')?.classList.add('drag-over');
    event.target.closest('.slot-item')?.classList.add('drag-over');
}

function onDropZoneDragLeave(event) {
    event.target.closest('.slot-drop-zone')?.classList.remove('drag-over');
    event.target.closest('.slot-item')?.classList.remove('drag-over');
}

function onDropZoneDrop(event, slotId) {
    event.preventDefault();
    event.target.closest('.slot-drop-zone')?.classList.remove('drag-over');
    event.target.closest('.slot-item')?.classList.remove('drag-over');

    const filename = event.dataTransfer.getData('text/plain');
    if (filename) {
        const slot = STATE.slots.find(s => s.id === slotId);
        if (slot) {
            slot.audio = filename;
            saveConfig();
            renderSlots();
            showToast('已绑定: ' + filename, 'success');
        }
    }
}

function onDropZoneClick(slotId) {
    // 点击时如果有音频文件则弹出选择
    if (STATE.audioFiles.length === 0) {
        showToast('音频库为空，请先上传音频文件', 'error');
        return;
    }
    // 简单的选择：在当前未绑定的音频中选取
    const available = STATE.audioFiles.filter(f =>
        !STATE.slots.some(s => s.audio === f.name && s.id !== slotId)
    );

    if (available.length === 0) {
        showToast('所有音频已绑定到时间段', 'error');
        return;
    }

    // 创建简易选择菜单
    const slot = STATE.slots.find(s => s.id === slotId);
    const menu = document.createElement('div');
    menu.className = 'audio-select-menu';
    menu.style.cssText = `
        position: fixed; background: white; border: 1px solid #D6E4F0;
        border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        max-height: 240px; overflow-y: auto; z-index: 500; min-width: 200px;
    `;
    menu.innerHTML = available.map(f => `
        <div style="padding: 8px 14px; cursor: pointer; font-size: 13px; border-bottom: 1px solid #F5F8FC;"
             onmouseover="this.style.background='#F5F8FC'"
             onmouseout="this.style.background='white'">
            ${escapeHtml(f.name)}
        </div>
    `).join('') + (slot.audio ? `
        <div style="padding: 8px 14px; cursor: pointer; font-size: 13px; color: #DC2626; border-top: 1px solid #D6E4F0;"
             onmouseover="this.style.background='#FEE2E2'"
             onmouseout="this.style.background='white'">
            解除绑定
        </div>
    ` : '');

    document.body.appendChild(menu);

    const rect = event.target.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';

    menu.addEventListener('click', (e) => {
        const text = e.target.textContent.trim();
        if (text === '解除绑定') {
            slot.audio = null;
        } else {
            slot.audio = text;
        }
        saveConfig();
        renderSlots();
        menu.remove();
    });

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// ==================== 拖拽 - 时间段排序 ====================
function onSlotDragStart(event, slotId) {
    STATE.dragData = { type: 'slot', slotId: slotId };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'slot-' + slotId);
}

function onSlotDragOver(event, slotId) {
    event.preventDefault();
    if (STATE.dragData && STATE.dragData.type === 'slot' && STATE.dragData.slotId !== slotId) {
        event.dataTransfer.dropEffect = 'move';
        const el = document.getElementById('slot-' + slotId);
        if (el) el.classList.add('drag-over');
    }
}

function onSlotDragLeave(event, slotId) {
    const el = document.getElementById('slot-' + slotId);
    if (el) el.classList.remove('drag-over');
}

function onSlotDrop(event, targetSlotId) {
    event.preventDefault();
    const el = document.getElementById('slot-' + targetSlotId);
    if (el) el.classList.remove('drag-over');

    if (STATE.dragData && STATE.dragData.type === 'slot') {
        const dragSlotId = STATE.dragData.slotId;
        if (dragSlotId !== targetSlotId) {
            const dragIdx = STATE.slots.findIndex(s => s.id === dragSlotId);
            const targetIdx = STATE.slots.findIndex(s => s.id === targetSlotId);
            if (dragIdx !== -1 && targetIdx !== -1) {
                const [moved] = STATE.slots.splice(dragIdx, 1);
                STATE.slots.splice(targetIdx, 0, moved);
                saveConfig();
                renderSlots();
            }
        }
    }
    // 也处理音频拖入时间段
    else if (STATE.dragData && STATE.dragData.type === 'audio') {
        const slot = STATE.slots.find(s => s.id === targetSlotId);
        if (slot) {
            slot.audio = STATE.dragData.filename;
            saveConfig();
            renderSlots();
            showToast('已绑定: ' + STATE.dragData.filename, 'success');
        }
    }
}

function onDragEnd(event) {
    STATE.dragData = null;
    document.querySelectorAll('.drag-over, .dragging').forEach(el => {
        el.classList.remove('drag-over', 'dragging');
    });
}

// ==================== 音频库折叠 ====================
function toggleLibrary() {
    const body = document.getElementById('libraryBody');
    const arrow = document.getElementById('libraryArrow');
    body.classList.toggle('collapsed');
    arrow.classList.toggle('collapsed');
}

// ==================== Toast 提示 ====================
let toastTimer;
function showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast ' + type + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}

// ==================== 工具函数 ====================
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ==================== 键盘快捷键 ====================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeRenameModal();
        closeDeleteModal();
        stopAllAudio();
    }
    if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        stopAllAudio();
    }
});

// 关闭弹窗（点击遮罩）
document.getElementById('renameModal').addEventListener('click', function(e) {
    if (e.target === this) closeRenameModal();
});
document.getElementById('deleteModal').addEventListener('click', function(e) {
    if (e.target === this) closeDeleteModal();
});

// 回车确认重命名
document.getElementById('renameInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') confirmRename();
});

// ==================== 时间段定时设置 ====================
function onSlotTimeChange(slotId, value) {
    const slot = STATE.slots.find(s => s.id === slotId);
    if (slot) {
        slot.time = value;
        saveConfig();
    }
}

// ==================== 定时播报 ====================
function toggleSchedule() {
    STATE.scheduleEnabled = document.getElementById('scheduleToggle').checked;
    saveConfig();
    updateScheduleUI();
}

function updateScheduleUI() {
    const toggle = document.getElementById('scheduleToggle');
    toggle.checked = STATE.scheduleEnabled;
    if (STATE.scheduleEnabled) {
        startSchedule();
        setStatus('定时播报已开启');
    } else {
        stopSchedule();
        setStatus('定时播报已关闭');
    }
}

function startSchedule() {
    stopSchedule();
    // 重置当日记录
    STATE.playedToday = new Set();
    STATE.lastCheckMinute = '';
    // 每5秒检查一次
    STATE.scheduleTimer = setInterval(checkSchedule, 5000);
    // 立即检查一次
    checkSchedule();
}

function stopSchedule() {
    if (STATE.scheduleTimer) {
        clearInterval(STATE.scheduleTimer);
        STATE.scheduleTimer = null;
    }
}

async function checkSchedule() {
    if (!STATE.scheduleEnabled) return;

    try {
        const res = await fetch('/api/check-schedule');
        const data = await res.json();
        if (!data.success) return;

        const currentMinute = data.current_time;
        // 防止同一分钟多次触发
        if (currentMinute === STATE.lastCheckMinute) return;
        STATE.lastCheckMinute = currentMinute;

        // 高亮匹配的时间段
        highlightScheduledSlots(data.matched);

        for (const m of data.matched) {
            // 避免重复播放
            if (STATE.playedToday.has(m.id)) continue;
            STATE.playedToday.add(m.id);

            // 自动播放
            const slot = STATE.slots.find(s => s.id === m.id);
            if (slot && slot.audio) {
                showToast('定时播报: ' + slot.audio, 'success');
                await playSlotAudio(slot);
            }
        }
    } catch (e) {
        // 静默失败，不影响用户体验
    }
}

function highlightScheduledSlots(matched) {
    // 清除所有高亮
    document.querySelectorAll('.slot-time-input').forEach(el => {
        el.classList.remove('schedule-due');
    });
    // 高亮匹配的
    for (const m of matched) {
        const slotEl = document.getElementById('slot-' + m.id);
        if (slotEl) {
            const timeInput = slotEl.querySelector('.slot-time-input');
            if (timeInput) timeInput.classList.add('schedule-due');
        }
    }
}

async function playSlotAudio(slot) {
    if (!slot || !slot.audio) return;
    const player = document.getElementById('audioPlayer');
    player.pause();
    player.currentTime = 0;
    player.src = `/api/audio/${encodeURIComponent(slot.audio)}`;
    try {
        await setAudioDevice();
        await player.play();
        STATE.currentPlaying = slot.id;
        updatePlayingUI();
        setStatus('定时播报: ' + slot.audio);
        document.getElementById('btnStopAll').disabled = false;
    } catch (e) {
        console.error('定时播放失败:', e);
        STATE.currentPlaying = null;
        updatePlayingUI();
    }
}

// ==================== 外部设备管理 ====================
async function refreshDevices() {
    try {
        // 请求音频输出设备列表
        const devices = await navigator.mediaDevices.enumerateDevices();
        STATE.audioDevices = devices.filter(d => d.kind === 'audiooutput');
        renderDeviceOptions();
    } catch (e) {
        console.error('获取设备列表失败:', e);
        STATE.audioDevices = [];
    }
}

function renderDeviceOptions() {
    const select = document.getElementById('deviceSelect');
    const currentVal = STATE.outputDeviceId;

    let html = '<option value="">默认设备</option>';
    for (const d of STATE.audioDevices) {
        const selected = d.deviceId === currentVal ? 'selected' : '';
        const label = d.label || ('音频设备 ' + d.deviceId.slice(0, 8));
        html += `<option value="${d.deviceId}" ${selected}>${escapeHtml(label)}</option>`;
    }
    select.innerHTML = html;
}

async function onDeviceChange() {
    const select = document.getElementById('deviceSelect');
    STATE.outputDeviceId = select.value;
    saveConfig();
    try {
        await setAudioDevice();
        if (STATE.outputDeviceId) {
            const device = STATE.audioDevices.find(d => d.deviceId === STATE.outputDeviceId);
            showToast('已切换到: ' + (device ? device.label : '所选设备'), 'success');
        }
    } catch (e) {
        showToast('设备切换失败: ' + e.message, 'error');
    }
}

async function setAudioDevice() {
    const player = document.getElementById('audioPlayer');
    if (!STATE.outputDeviceId) return;
    try {
        // 使用 setSinkId 将音频路由到指定设备
        if (typeof player.setSinkId === 'function') {
            await player.setSinkId(STATE.outputDeviceId);
        }
    } catch (e) {
        console.error('设置音频设备失败:', e);
    }
}