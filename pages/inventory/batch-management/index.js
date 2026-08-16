// ============================================
// BATCH MANAGEMENT - SELF EXECUTING MODULE
// ============================================

(async function initBatchPage() {
    console.log("Batch page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    await loadBatches();

    const searchInput = document.getElementById('searchBatch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filterBatches(e.target.value);
        });
        console.log("✅ Search listener attached.");
    } else {
        console.warn("⚠️ Search input (#searchBatch) not found.");
    }
})();

async function loadBatches() {
    const tbody = document.getElementById('batchTableBody');

    if (!tbody) {
        console.error("❌ batchTableBody element not found in HTML!");
        return;
    }

    try {
        console.log("Fetching batches from Supabase...");
        
        // ✅ SIMPLIFIED: Only fetch the columns that actually exist
        const { data: batches, error } = await supabaseClient
            .from('batches')
            .select(`
                id,
                batch_number,
                expiry_date,
                cost_price,
                total_qty,
                products:product_id ( 
                    product_name
                )
            `)
            .order('expiry_date', { ascending: true });

        if (error) {
            console.error("Supabase Error:", error);
            throw error;
        }

        console.log("Batches fetched:", batches);

        if (batches.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #94a3b8;">No batches found.</td></tr>`;
            return;
        }

        renderBatches(batches);

    } catch (error) {
        console.error("Error loading batches:", error);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message || error}</td></tr>`;
    }
}

function renderBatches(batches) {
    const tbody = document.getElementById('batchTableBody');
    const today = new Date();
    
    tbody.innerHTML = batches.map(batch => {
        const expiry = new Date(batch.expiry_date);
        const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
        
        let rowClass = '';
        let expiryClass = '';
        if (daysUntilExpiry < 0) {
            rowClass = 'style="background: #fef2f2;"';
            expiryClass = 'style="color: #dc2626; font-weight: bold;"';
        } else if (daysUntilExpiry <= 30) {
            rowClass = 'style="background: #fffbeb;"';
            expiryClass = 'style="color: #d97706; font-weight: bold;"';
        } else {
            expiryClass = 'style="color: #15803d;"';
        }

        // ✅ SIMPLIFIED: Directly use total_qty and cost_price
        const totalQty = batch.total_qty || 0;
        const totalAmount = totalQty * parseFloat(batch.cost_price || 0);

        return `
            <tr ${rowClass} data-batch="${batch.batch_number}">
                <td style="padding-left: 20px; font-family: monospace; font-weight: 500;">${batch.batch_number}</td>
                <td>${batch.products?.product_name || 'Unknown Product'}</td>
                <td ${expiryClass}>${new Date(batch.expiry_date).toLocaleDateString()}</td>
                <td>K${parseFloat(batch.cost_price).toFixed(2)}</td>
                <td style="text-align: right; font-weight: bold;">${totalQty}</td>
                <td style="padding-right: 20px; text-align: right; font-weight: bold;">
                    K${totalAmount.toFixed(2)}
                </td>
            </tr>
        `;
    }).join('');
}

function filterBatches(searchTerm) {
    const rows = document.querySelectorAll('#batchTableBody tr');
    const term = searchTerm.toLowerCase();

    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(term) ? '' : 'none';
    });
}