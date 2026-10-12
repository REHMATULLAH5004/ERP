// ============================================
// SHARED EXCEL EXPORT
// ============================================
// The Sales, Purchase and Inventory reports all call
//     exportRowsToExcel(filename, sheetName, rows)
// and expect a plain true/false back, but that function was never actually
// defined anywhere -- so every "Download Excel" button on those reports hit
// the `: false` fallback and showed "check the browser console", with
// nothing in the console, because nothing had gone wrong as far as the
// code could tell.
//
// rows = array of flat objects; the keys of the first row become the column
// headers. Returns true on success, false (and logs why) on failure.
//
// Uses SheetJS (window.XLSX, loaded in index.html). If that library is
// blocked/offline this falls back to a CSV download (Excel opens it fine)
// instead of failing outright.
(function () {
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function csvCell(v) {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    window.exportRowsToExcel = function (filename, sheetName, rows) {
        try {
            if (!Array.isArray(rows) || rows.length === 0) {
                console.error('exportRowsToExcel: no rows to export');
                return false;
            }

            if (window.XLSX && XLSX.utils && XLSX.writeFile) {
                const ws = XLSX.utils.json_to_sheet(rows);
                const headers = Object.keys(rows[0]);
                ws['!cols'] = headers.map(h => {
                    const longest = rows.reduce((m, r) => Math.max(m, String(r[h] ?? '').length), h.length);
                    return { wch: Math.min(Math.max(longest + 2, 10), 50) };
                });
                const wb = XLSX.utils.book_new();
                // Excel limits sheet names to 31 chars and forbids : \ / ? * [ ]
                const safeName = String(sheetName || 'Sheet1').replace(/[:\\\/?*\[\]]/g, ' ').slice(0, 31);
                XLSX.utils.book_append_sheet(wb, ws, safeName);
                XLSX.writeFile(wb, filename);
                return true;
            }

            console.warn('exportRowsToExcel: SheetJS (XLSX) not loaded -- falling back to CSV');
            const headers = Object.keys(rows[0]);
            const lines = [headers.map(csvCell).join(',')]
                .concat(rows.map(r => headers.map(h => csvCell(r[h])).join(',')));
            const csvName = String(filename).replace(/\.xlsx$/i, '') + '.csv';
            downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }), csvName);
            return true;
        } catch (err) {
            console.error('exportRowsToExcel failed:', err);
            return false;
        }
    };
})();