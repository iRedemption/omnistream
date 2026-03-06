import { activeStreams } from './state.js';
import { renderApp } from './uiRender.js';
import { updateUrlHash } from './urlSync.js';
import { resizeStreams } from './players.js';

let followedAccounts = JSON.parse(localStorage.getItem('omnistream_followed') || '[]');
let followedTimes = JSON.parse(localStorage.getItem('omnistream_followed_times') || '{}');

let currentData = [];
let sortMode = localStorage.getItem('omnistream_followed_sort') || 'viewers';
let showingAll = false;
let isFetching = false;

export function initFollowedChannels() {
    const showBtn = document.getElementById('show-follow-input-btn');
    const inputGroup = document.getElementById('follow-input-group');
    const inputEl = document.getElementById('follow-input');
    const addBtn = document.getElementById('add-followed-btn');
    const sortSelect = document.getElementById('followed-sort-select');
    const errorMsg = document.getElementById('follow-error-msg');

    if (!showBtn) return;

    sortSelect.value = sortMode;

    showBtn.addEventListener('click', (e) => {
        // Stop propagation to avoid chevron toggle if user clicks specifically on plus
        e.stopPropagation();

        const section = showBtn.closest('.sidebar-section');
        const content = section.querySelector('.sidebar-section-content');

        // Uncollapse if collapsed
        if (section.classList.contains('collapsed')) {
            section.classList.remove('collapsed');
            if (content) content.style.display = 'block';
            // Update the chevron icon
            const icon = section.querySelector('.toggle-icon');
            if (icon) {
                icon.classList.remove('fa-chevron-right');
                icon.classList.add('fa-chevron-down');
            }
        }

        // Toggle input field
        const isHidden = inputGroup.style.display === 'none';
        inputGroup.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) inputEl.focus();
    });

    const triggerAdd = () => {
        const val = inputEl.value.trim();
        if (!val) {
            inputGroup.style.display = 'none';
            return;
        }

        const platformIconContainer = document.getElementById('follow-platform-icon-container');
        const isTwitch = platformIconContainer.querySelector('i').classList.contains('fa-twitch');
        const platform = isTwitch ? 'twitch' : 'youtube';

        if (platform === 'twitch') {
            let login = val.toLowerCase();
            try {
                if (val.includes('twitch.tv/')) {
                    const url = new URL(val.startsWith('http') ? val : 'https://' + val);
                    login = url.pathname.split('/')[1].toLowerCase();
                }
            } catch (e) { }

            if (!login) {
                errorMsg.textContent = 'Invalid channel';
                setTimeout(() => errorMsg.textContent = '', 3000);
                return;
            }

            if (followedAccounts.some(a => a.login === login && (a.platform === 'twitch' || !a.platform))) {
                errorMsg.textContent = 'Already followed';
                setTimeout(() => errorMsg.textContent = '', 3000);
                return;
            }

            errorMsg.textContent = '';
            followedAccounts.push({ login, platform: 'twitch', addedAt: Date.now() });
            localStorage.setItem('omnistream_followed', JSON.stringify(followedAccounts));

            inputEl.value = '';
            inputGroup.style.display = 'none';
            fetchFollowedData();
        } else {
            // YouTube
            // Show loading
            let q = val;
            try {
                if (val.includes('youtube.com/') || val.includes('youtu.be/')) {
                    const url = new URL(val.startsWith('http') ? val : 'https://' + val);
                    const path = url.pathname;

                    if (path.startsWith('/@')) {
                        q = path.substring(1); // keep the @
                    } else if (path.startsWith('/c/')) {
                        q = path.substring(3); // username
                    } else if (path.startsWith('/channel/')) {
                        q = path.substring(9); // channel ID
                    } else if (path.length > 1) {
                        q = path.split('/')[1]; // custom url like /WatchALTER
                    }
                } else if (!val.startsWith('@') && !val.startsWith('UC')) {
                    // Try to assume it's a handle if they just typed 'ludwig' -> '@ludwig'
                    // but we'll let the backend handle the forUsername vs forHandle logic.
                }
            } catch (e) { }

            const origIcon = document.getElementById('add-followed-btn').innerHTML;
            document.getElementById('add-followed-btn').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            document.getElementById('add-followed-btn').disabled = true;

            fetch(`/api/youtube/resolve?q=${encodeURIComponent(q)}`)
                .then(r => {
                    if (!r.ok) throw new Error('Not found');
                    return r.json();
                })
                .then(data => {
                    const id = data.id;
                    if (followedAccounts.some(a => a.id === id && a.platform === 'youtube')) {
                        errorMsg.textContent = 'Already followed';
                        setTimeout(() => errorMsg.textContent = '', 3000);
                        return;
                    }
                    followedAccounts.push({ login: data.title, id: data.id, platform: 'youtube', addedAt: Date.now() });
                    localStorage.setItem('omnistream_followed', JSON.stringify(followedAccounts));

                    inputEl.value = '';
                    inputGroup.style.display = 'none';
                    fetchFollowedData();
                })
                .catch(err => {
                    errorMsg.textContent = 'YouTube channel not found';
                    setTimeout(() => errorMsg.textContent = '', 3000);
                })
                .finally(() => {
                    document.getElementById('add-followed-btn').innerHTML = origIcon;
                    document.getElementById('add-followed-btn').disabled = false;
                });
        }
    };

    addBtn.addEventListener('click', triggerAdd);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') triggerAdd();
        if (e.key === 'Escape') {
            inputEl.value = '';
            inputGroup.style.display = 'none';
        }
    });

    sortSelect.addEventListener('change', (e) => {
        sortMode = e.target.value;
        localStorage.setItem('omnistream_followed_sort', sortMode);
        renderFollowedList();
    });

    document.getElementById('show-more-followed').addEventListener('click', () => {
        showingAll = true;
        renderFollowedList();
    });

    document.getElementById('show-less-followed').addEventListener('click', () => {
        showingAll = false;
        renderFollowedList();
    });

    fetchFollowedData();
    setInterval(fetchFollowedData, 60000);
}

async function fetchFollowedData() {
    if (followedAccounts.length === 0) {
        currentData = [];
        renderFollowedList();
        return;
    }
    if (isFetching) return;
    isFetching = true;

    try {
        const twitchAccounts = followedAccounts.filter(a => a.platform === 'twitch' || !a.platform);
        const youtubeAccounts = followedAccounts.filter(a => a.platform === 'youtube');

        let allData = [];

        // Fetch Twitch
        if (twitchAccounts.length > 0) {
            const logins = twitchAccounts.map(a => a.login).join(',');
            const res = await fetch(`/api/twitch/followed?logins=${logins}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    data.forEach(d => d.platform = 'twitch');
                    allData = allData.concat(data);
                }
            }
        }

        // Fetch YouTube
        if (youtubeAccounts.length > 0) {
            const ids = youtubeAccounts.map(a => a.id).join(',');
            const res = await fetch(`/api/youtube/followed?ids=${ids}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    data.forEach(d => {
                        d.platform = 'youtube';
                    });
                    allData = allData.concat(data);
                }
            }
        }

        currentData = allData;
        renderFollowedList();
    } catch (e) {
        console.error('Failed to fetch followed channels', e);
    } finally {
        isFetching = false;
    }
}

function renderFollowedList() {
    const listEl = document.getElementById('followed-channels-list');
    const noMsg = document.getElementById('no-followed-msg');
    const pagination = document.getElementById('followed-pagination');
    const showMore = document.getElementById('show-more-followed');
    const showLess = document.getElementById('show-less-followed');

    if (followedAccounts.length === 0) {
        listEl.innerHTML = '';
        noMsg.style.display = 'block';
        pagination.style.display = 'none';
        return;
    }

    noMsg.style.display = 'none';

    // Merge API data with localStorage times
    let enrichedData = currentData.map(d => ({
        ...d,
        lastViewed: followedTimes[d.user_login] || 0
    }));

    // Find if the accounts exist but api failed
    const apiLoginsT = new Set(enrichedData.filter(d => d.platform === 'twitch').map(d => d.user_login));
    const apiLoginsY = new Set(enrichedData.filter(d => d.platform === 'youtube').map(d => d.user_login));

    for (const acc of followedAccounts) {
        const platform = acc.platform || 'twitch';
        if (platform === 'twitch' && !apiLoginsT.has(acc.login)) {
            enrichedData.push({
                user_name: acc.login,
                user_login: acc.login,
                platform: 'twitch',
                profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/8a6381c7-d0c0-4576-b179-38bd5ce1d6af-profile_image-300x300.png',
                is_live: false,
                viewer_count: 0,
                title: '',
                game_name: '',
                lastViewed: followedTimes[acc.login] || 0
            });
        } else if (platform === 'youtube' && !apiLoginsY.has(acc.id)) {
            enrichedData.push({
                user_name: acc.login,
                user_login: acc.id,
                platform: 'youtube',
                profile_image_url: 'https://www.youtube.com/img/desktop/yt_1200.png', // Generic YT icon
                is_live: false,
                viewer_count: 0,
                title: '',
                game_name: '',
                lastViewed: followedTimes[acc.login] || 0
            });
        }
    }

    enrichedData.sort((a, b) => {
        // Live always above offline
        if (a.is_live && !b.is_live) return -1;
        if (!a.is_live && b.is_live) return 1;

        if (sortMode === 'viewers') {
            if (a.is_live && b.is_live) {
                return b.viewer_count - a.viewer_count;
            } else {
                return b.lastViewed - a.lastViewed;
            }
        } else if (sortMode === 'last_viewed') {
            return b.lastViewed - a.lastViewed;
        } else if (sortMode === 'alphabetical') {
            return a.user_login.localeCompare(b.user_login);
        }
        return 0;
    });

    const maxDefault = 7;
    const maxExpanded = 17;
    const limit = showingAll ? maxExpanded : maxDefault;
    const displayData = enrichedData.slice(0, limit);

    listEl.innerHTML = '';

    displayData.forEach(item => {
        const li = document.createElement('li');
        li.className = 'followed-item';
        if (item.title) li.title = item.title;
        else li.title = item.user_name || item.user_login;

        const img = document.createElement('img');
        img.className = 'followed-avatar';
        img.src = item.profile_image_url;
        img.onerror = () => { img.src = 'https://static-cdn.jtvnw.net/jtv_user_pictures/8a6381c7-d0c0-4576-b179-38bd5ce1d6af-profile_image-300x300.png'; };

        const info = document.createElement('div');
        info.className = 'followed-info';

        const name = document.createElement('div');
        name.className = 'followed-name';
        name.textContent = item.user_name || item.user_login;
        info.appendChild(name);

        if (item.game_name || item.is_live) {
            const game = document.createElement('div');
            game.className = 'followed-game';
            game.textContent = item.game_name || 'Offline';
            info.appendChild(game);
        } else if (!item.is_live) {
            const game = document.createElement('div');
            game.className = 'followed-game';
            game.textContent = 'Offline';
            info.appendChild(game);
        }

        const status = document.createElement('div');
        status.className = 'followed-status';

        if (item.is_live) {
            const viewers = document.createElement('div');
            viewers.className = 'followed-viewers';

            const dot = document.createElement('div');
            dot.className = 'live-dot';

            const vText = document.createElement('span');
            let vCount = item.viewer_count;
            if (vCount < 1000) {
                vText.textContent = vCount.toString();
            } else if (vCount >= 100000) {
                vText.textContent = Math.round(vCount / 1000) + 'K';
            } else {
                vText.textContent = (vCount / 1000).toFixed(1) + 'K';
            }

            viewers.appendChild(dot);
            viewers.appendChild(vText);
            status.appendChild(viewers);
        } else {
            status.textContent = 'Offline';
            status.style.color = '#a0a0ab';
            status.style.fontWeight = 'normal';
        }

        li.appendChild(img);
        li.appendChild(info);
        li.appendChild(status);

        // Click handler to add stream
        li.addEventListener('click', () => {
            // Update last viewed
            followedTimes[item.user_login] = Date.now();
            localStorage.setItem('omnistream_followed_times', JSON.stringify(followedTimes));
            renderFollowedList(); // re-sort if necessary

            // Add stream
            const streamType = item.platform || 'twitch';
            if (activeStreams.some(s => s.type === streamType && s.id === item.user_login)) {
                return; // already added
            }
            activeStreams.push({
                type: streamType,
                id: item.user_login,
                videoId: item.video_id,
                label: item.user_name || item.user_login,
                uid: Date.now().toString()
            });
            updateUrlHash();
            renderApp();
            resizeStreams();
        });

        // Add a small delete button for unfollow
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (confirm(`Unfollow ${item.user_name || item.user_login}?`)) {
                if (item.platform === 'youtube') {
                    followedAccounts = followedAccounts.filter(a => !(a.id === item.user_login && a.platform === 'youtube'));
                } else {
                    followedAccounts = followedAccounts.filter(a => !(a.login === item.user_login && (a.platform === 'twitch' || !a.platform)));
                }
                localStorage.setItem('omnistream_followed', JSON.stringify(followedAccounts));
                fetchFollowedData();
            }
        });

        listEl.appendChild(li);
    });

    if (enrichedData.length > maxDefault) {
        pagination.style.display = 'flex';
        if (showingAll) {
            showMore.style.visibility = 'hidden';
            showLess.style.display = 'inline';
        } else {
            showMore.style.visibility = 'visible';
            showLess.style.display = 'none';
        }
    } else {
        pagination.style.display = 'none';
    }
}
