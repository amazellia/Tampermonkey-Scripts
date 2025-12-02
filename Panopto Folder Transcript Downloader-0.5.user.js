
// ==UserScript==
// @name         Panopto Folder Transcript Downloader
// @namespace    https://uoncapture.ap.panopto.com/
// @version      0.5
// @description  Adds a banner button (next to Stats) to download edited captions/transcripts for all sessions in the folder and zip them.
// @author       Tim Garside, Amanda Viray
// @match        https://uoncapture.ap.panopto.com/Panopto/Pages/Sessions/*
// @updateURL    https://github.com/amazellia/Tampermonkey-Scripts/blob/main/Panopto%20Folder%20Transcript%20Downloader-0.5.user.js
// @downloadURL  https://github.com/amazellia/Tampermonkey-Scripts/blob/main/Panopto%20Folder%20Transcript%20Downloader-0.5.user.js
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(function() {
    // ===== CONFIG =====
    const ZIP_NAME_PREFIX = 'panopto';

    const siteBase = location.origin; // https://your.hosted.panopto.com
    const apiBase = `${siteBase}/Panopto/api/v1`;

    // ===== UTILITIES =====
    function sanitizeFileName(name) {
        return (name || '').replace(/[\\/:*?"<>|]+/g, '_').trim();
    }
    function truncate(str, n) {
        if (!str) return '';
        return str.length <= n ? str : str.slice(0, n);
    }

    function getFolderIdFromHash() {
        const m = location.hash.match(/folderID=%22?([0-9a-fA-F-]{36})?%22/);
        return m ? m[1] : null;
    }

    async function crawlFolderTree(folderId, parentPath = '', zip, mode) {
        const folderMeta = await getFolder(folderId);
        const folderName = sanitizeFileName(folderMeta.Name || folderId);
        const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
        const zipFolder = zip.folder(folderPath);

        // Download sessions in this folder
        const sessions = await listAllSessions(folderId);

        for (const s of sessions) {
            const sessionName = sanitizeFileName(s.Name || s.Id);
            if (!s.Urls?.CaptionDownloadUrl) continue;

            const raw = await fetchCaption(s.Urls.CaptionDownloadUrl);
            const clean = srtOrVttToTranscript(raw);

            if (mode === 'captions') {
                zipFolder.file(`${sessionName}.vtt`, raw);

            } else if (mode === 'transcripts') {
                zipFolder.file(`${sessionName}.txt`, clean);

            } else if (mode === 'all') {
                zipFolder.folder('captions').file(`${sessionName}.vtt`, raw);
                zipFolder.folder('transcripts').file(`${sessionName}.txt`, clean);
            }
        }

        // Recursively process child folders
        const children = await listChildFolders(folderId);
        for (const child of children) {
            await crawlFolderTree(child.Id, folderPath, zip, mode);
        }
    }
    // ===== BANNER INJECTION (next to Stats button) =====
    function injectDownloadDropdown() {
    const header = document.getElementById('headerWrapper');
    if (!header) return false;

    const statsBtn = document.getElementById('headerStatsLink');
    if (!statsBtn) return false;

    // Wrapper
    const container = document.createElement('div');
    container.style.cssText = `
        display:inline-block;
        position:relative;
        margin-left:12px;
    `;

    // Dropdown button
    const btn = document.createElement('a');
    btn.href = '#';
    btn.textContent = 'Download Options ▾';
    btn.setAttribute('id', 'headerDownloadDropdown');
    btn.style.cssText = `
        display:inline-block; padding:6px 12px;
        border:1px solid rgba(255,255,255,0.7); border-radius:18px;
        color:#fff; text-decoration:none; font:600 13px/1.3 Segoe UI, Roboto, Arial, sans-serif;
        background:transparent; backdrop-filter:saturate(120%);
        cursor:pointer;
    `;

    // Dropdown menu container
    const menu = document.createElement('div');
    menu.style.cssText = `
        display:none;
        position:absolute;
        top:110%;
        left:0;
        background:#2c2c2c;
        border:1px solid rgba(255,255,255,0.25);
        border-radius:8px;
        padding:6px 0;
        z-index:99999;
        min-width:180px;
    `;

    // Dropdown items definition
    const options = [
        { label: "Download Captions", value: "captions" },
        { label: "Download Transcripts", value: "transcripts" },
        { label: "Download all in current folder", value: "all" },
        { label: "Download all (Including Sub-folders)", value: "all", recursive: true }
        // ➤ Add more here in the future!
        // { label: "Download CSV", value: "csv" },
    ];

    // Build menu items
    options.forEach(opt => {
        const item = document.createElement('div');
        item.textContent = opt.label;
        item.style.cssText = `
            padding:8px 14px;
            color:white;
            cursor:pointer;
            font-size:13px;
        `;
        item.addEventListener('mouseover', () =>
            item.style.background = "rgba(255,255,255,0.15)"
        );
        item.addEventListener('mouseout', () =>
            item.style.background = "transparent"
        );
        item.addEventListener('click', (e) => {
            e.preventDefault();
            menu.style.display = "none";
           if (opt.recursive) {
               runRecursive(opt.value);// NEW function below
           } else {
               run(opt.value);// Your existing single-folder download
           }
        });
        menu.appendChild(item);
    });

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        menu.style.display = (menu.style.display === "none") ? "block" : "none";
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            menu.style.display = "none";
        }
    });

    // mount
    container.appendChild(btn);
    container.appendChild(menu);
    statsBtn.parentNode.insertBefore(container, statsBtn.nextSibling);

    return true;
}



    function showLoading() {
        const el = document.getElementById('loadingMessage');
         if (el) el.style.display = 'block'; // or 'block' depending on your CSS
    }

    function hideLoading() {
        const el = document.getElementById('loadingMessage');
        if (el) el.style.display = 'none';
    }

    // ===== MAIN FLOW =====
    async function run(button) {
        showLoading();
        try {
            const folderId = getFolderIdFromHash();
            if (!folderId) {
                alert('No folderID found in the URL fragment. Expected: #folderID="GUID"');
                return;
            }

            // List sessions
            const sessions = await listAllSessions(folderId);
            const rawFolderName = sanitizeFileName(sessions[0].FolderDetails.Name || 'folder');
            const shortFolderName = truncate(rawFolderName, 30);
            if (!sessions.length) {
                alert('No sessions found in this folder. (Archived sessions are not returned by the REST endpoint.)');
                return;
            }

            // Process captions and zip
            const zip = new JSZip();
            let added = 0;

            for (const s of sessions) {
                const deliveryId = s.Id || s.DeliveryId || s.id;
                if (!deliveryId) continue;

                //const session = await getSession(deliveryId);
                const sessionName = sanitizeFileName(s.Name || `session-${deliveryId}`);
                const urls = s.Urls || {};
                const captionUrl = urls.CaptionDownloadUrl;
                if (!captionUrl) continue;

                const raw = await fetchCaption(captionUrl);
                let transcript ='';
                if (button === 'transcripts') {
                    // transcripts only
                    transcript = srtOrVttToTranscript(raw);
                    zip.file(`${sessionName}.txt`, transcript, { binary: false });
                    added++;

                } else if (button === 'captions') {
                    // captions only
                    zip.file(`${sessionName}.vtt`, raw, { binary: false });
                    added++;

                } else if (button === 'all') {
                    // BOTH → organised in folders
                    const clean = srtOrVttToTranscript(raw);
                    zip.folder('captions').file(`${sessionName}.vtt`, raw, { binary: false });
                    zip.folder('transcripts').file(`${sessionName}.txt`, clean, { binary: false });
                    added++;
                }
            }

            if (added === 0) {
                alert('No caption files available to download in this folder.');
                return;
            }

            const timestamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
            const zipName = `${ZIP_NAME_PREFIX}-${button}-${shortFolderName}-${timestamp}.zip`;

            // Example: Generate and download a zip file
            zip.generateAsync({type:"blob"})
                .then(function(content) {
                // You would typically use a library or a browser API to trigger the download
                // For example, creating a temporary link and clicking it
                var url = URL.createObjectURL(content);
                var a = document.createElement('a');
                a.href = url;
                a.download = zipName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });
            hideLoading();
            alert(`Downloaded ${added} transcript(s) in ${zipName}`);
        } catch (err) {
            console.error(err);
            alert(`Error: ${err.message}`);
        }
    }

    async function listChildFolders(folderId) {
    const res = await fetch(`${apiBase}/folders/${folderId}/children`, {
        method: "GET",
        credentials: "include",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
    });

    if (!res.ok) throw new Error(`Child folder API error: ${res.status}`);
    const json = await res.json();

    return json.Results || json.Items || json || [];
}

    async function runRecursive(mode) {
    showLoading();

    try {
        const folderId = getFolderIdFromHash();
        if (!folderId) {
            alert("No folderID found in the URL.");
            return;
        }

        const zip = new JSZip();

        // Start recursive download
        await crawlFolderTree(folderId, '', zip, mode);

        const filesAdded = Object.keys(zip.files).length;
        if (filesAdded === 0) {
            alert("No files found in this folder or sub-folders.");
            return;
        }

        const folderMeta = await getFolder(folderId);
        const folderName = sanitizeFileName(folderMeta.Name || folderId).slice(0, 30);
        const timestamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');

        const zipName = `panopto-${mode}-recursive-${folderName}-${timestamp}.zip`;

        const content = await zip.generateAsync({ type: "blob" });

        const a = document.createElement('a');
        a.href = URL.createObjectURL(content);
        a.download = zipName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        alert(`Downloaded ${filesAdded} items including sub-folders.`);
    }
    catch (err) {
        console.error(err);
        alert("Recursive download error: " + err.message);
    }
    finally {
        hideLoading();
    }
}


    // ===== API CALLS =====
    async function getFolder(folderId) {
        const options = {
            method: "GET",
            credentials: "include",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
        };

        const res = await fetch(`${apiBase}/folders/${folderId}`, options);
        if (!res.ok) throw new Error(`Folder ${folderId} fetch error: ${res.status}`);
        return res.json();
    }

    async function listAllSessions(folderId) {
        let allSessions = [];
        let page = 0;
        let pageSize = 50;
        let hasMore = true;
        const options = {
            method: "GET",
            credentials: "include",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
        };
        while (hasMore) {
            const res = await fetch(`${apiBase}/folders/${folderId}/sessions?pageNumber=${page}`, options);
            if (!res.ok) throw new Error(`Sessions API error: ${res.status}`);
            const data = await res.json();

            const items = Array.isArray(data) ? data : (data.Results || data.Items || []);
            allSessions.push(...items);
            // Check if there are more pages
            hasMore = items.length === pageSize;
            page++;
        }
        return allSessions;
    }

    // Fetch caption via CaptionDownloadUrl; rely on Panopto cookie for Restricted folders
    async function fetchCaption(captionUrl) {
        const options = {
            credentials: "include"
        };
        const res = await fetch(captionUrl, options);
        if (!res.ok) throw new Error(`Caption download error: ${res.status}`);
        return res.text();
    }

    // ===== CAPTION NORMALIZATION =====
    // Convert SRT/VTT to plain transcript text by stripping indices & timestamps; if already transcript, return as-is.

    function srtOrVttToTranscript(text) {
        // If no timestamps or WEBVTT header, return as-is
        if (!/-->\s*\d{2}:\d{2}:\d{2}/.test(text) && !/WEBVTT/i.test(text)) {
            return text;
        }

        const lines = text.split(/\r?\n/);
        const out = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Skip numeric index lines
            if (/^\d+$/.test(line)) continue;

            // Skip timestamp lines (handles SRT and VTT)
            if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(line)) continue;

            // Skip WEBVTT header
            if (/^WEBVTT/i.test(line)) continue;

            // Skip empty lines
            if (!line) continue;

            // Remove position/cue settings if present
            out.push(line.replace(/\s*position:\d+%.*$/i, '').trim());
        }

        let transcript = out.join('\n').replace(/\n{3,}/g, '\n\n');

        // ===== NORMALIZE PUNCTUATION & SPACING =====
        transcript = transcript
            .replace(/\s{2,}/g, ' ') // collapse multiple spaces
            .replace(/([,.!?])\s*/g, '$1 ') // ensure space after punctuation
            .replace(/\s+([,.!?])/g, '$1') // remove space before punctuation
            .replace(/,+/g, ',') // collapse multiple commas
            .replace(/\.{4,}/g, '...') // normalize ellipses
            .trim();

        return transcript;
    }


    // ===== INIT =====
    // Try banner injection first; if we can't locate header elements, fall back to floating button.
    injectDownloadDropdown();


    const observer = new MutationObserver(() => {
    if (!document.getElementById('headerDownloadDropdown')) {
        injectDownloadDropdown();
    }
});

observer.observe(document.body, { childList: true, subtree: true });

})();
