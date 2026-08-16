// ============================================
// ADMIN - BACKUPS
// ============================================
// Shows the history of the daily ERP backup (see public.backup_runs)
// and lets an Admin trigger one on demand. The actual backup work
// happens entirely server-side in the "daily-backup" Supabase Edge
// Function, scheduled nightly by pg_cron -- this page only reads the
// log and, for "Run Backup Now", invokes that same function with the
// admin's own session (the function verifies the Admin role itself
// server-side before doing anything).
//
// SCHEMA THIS FILE NEEDS:
//   backup_runs (id, started_at, finished_at, status, triggered_by,
//                 table_count, row_count, file_path, file_size_bytes,
//                 error_message)
//   Storage bucket "backups" (private; admin-only via RLS)
// ============================================

(async function initAdminBackupsPage() {
    console.log("Admin Backups page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const state = { runs: [] };

    const runBtn = document.getElementById('runBackupNowBtn');
    const tbody = document.getElementById('backupTableBody');
    const banner = document.getElementById('backupStatusBanner');

    // ============================================
    // HELPERS
    // ============================================
    function formatBytes(bytes) {
        if (bytes === null || bytes === undefined) return '--';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function formatDate(iso) {
        if (!iso) return '--';
        return new Date(iso).toLocaleString();
    }

    function statusBadge(status) {
        const map = {
            success: { bg: '#dcfce7', color: '#15803d', label: 'Success' },
            error: { bg: '#fee2e2', color: '#dc2626', label: 'Error' },
            running: { bg: '#fef9c3', color: '#a16207', label: 'Running' },
        };
        const s = map[status] || map.running;
        return `<span style="background:${s.bg};color:${s.color};padding:3px 10px;border-radius:10px;font-size:0.75rem;font-weight:500;">${s.label}</span>`;
    }

    function showBanner(message, kind) {
        const styles = {
            info: { bg: '#dbeafe', color: '#1d4ed8' },
            success: { bg: '#dcfce7', color: '#15803d' },
            error: { bg: '#fee2e2', color: '#dc2626' },
        };
        const s = styles[kind] || styles.info;
        banner.style.background = s.bg;
        banner.style.color = s.color;
        banner.textContent = message;
        banner.style.display = 'block';
    }

    // ============================================
    // LOAD + RENDER HISTORY
    // ============================================
    async function loadRuns() {
        const { data, error } = await supabaseClient
            .from('backup_runs')
            .select('*')
            .order('started_at', { ascending: false })
            .limit(20);
        if (error) {
            console.error('Error loading backup_runs:', error);
            state.runs = [];
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:#dc2626;">Could not load backup history: ${error.message}</td></tr>`;
            return;
        }
        state.runs = data || [];
    }

    function renderRuns() {
        if (state.runs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #94a3b8;">No backups have run yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = state.runs.map(r => `
            <tr>
                <td style="padding-left: 20px;">${formatDate(r.started_at)}</td>
                <td>${statusBadge(r.status)}</td>
                <td style="text-transform: capitalize;">${r.triggered_by}</td>
                <td>${r.table_count ?? '--'}</td>
                <td>${r.row_count ?? '--'}</td>
                <td>${formatBytes(r.file_size_bytes)}</td>
                <td style="padding-right: 20px; text-align: right;">
                    ${r.status === 'success' && r.file_path
                        ? `<button class="download-backup-btn" data-path="${r.file_path}" style="background:none;border:none;color:#2563eb;cursor:pointer;">
                               <i class="fa-solid fa-download"></i> Download
                           </button>`
                        : (r.status === 'error'
                            ? `<span title="${(r.error_message || '').replace(/"/g, '&quot;')}" style="color:#dc2626; font-size:0.75rem; cursor:help;">
                                   <i class="fa-solid fa-circle-info"></i> details
                               </span>`
                            : '--')}
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.download-backup-btn').forEach(btn => {
            btn.addEventListener('click', () => downloadBackup(btn.dataset.path));
        });
    }

    // ============================================
    // DOWNLOAD (signed URL -- bucket is private)
    // ============================================
    async function downloadBackup(filePath) {
        const { data, error } = await supabaseClient
            .storage
            .from('backups')
            .createSignedUrl(filePath, 60); // 60 seconds is plenty to start the download

        if (error) {
            alert('Could not create a download link: ' + error.message);
            return;
        }
        window.open(data.signedUrl, '_blank');
    }

    // ============================================
    // RUN BACKUP NOW
    // ============================================
    runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        runBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running...';
        showBanner('Running backup now -- this usually takes a few seconds...', 'info');

        try {
            const { data, error } = await supabaseClient.functions.invoke('daily-backup', { body: {} });
            if (error) throw error;
            if (data && data.ok === false) throw new Error(data.error || 'Backup failed');

            showBanner(`✅ Backup complete -- ${data.tableCount} tables, ${data.rowCount} rows.`, 'success');
        } catch (error) {
            console.error('Error running backup:', error);
            showBanner('❌ Backup failed: ' + (error.message || error), 'error');
        } finally {
            runBtn.disabled = false;
            runBtn.innerHTML = '<i class="fa-solid fa-play"></i> Run Backup Now';
            await refresh();
        }
    });

    // ============================================
    // REFRESH / INIT
    // ============================================
    async function refresh() {
        await loadRuns();
        renderRuns();
    }

    await refresh();
    console.log("✅ Admin Backups page initialized successfully!");
})();
