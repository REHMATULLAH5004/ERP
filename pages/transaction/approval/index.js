// ============================================
// APPROVAL QUEUE MODULE
// ============================================

(async function initApprovalPage() {
    console.log("✅ Approval Queue module initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // STATE
    // ============================================
    const state = {
        approvals: [],
        pendingItems: []
    };

    // ============================================
    // LOAD DATA
    // ============================================

    async function loadApprovals() {
        try {
            console.log("📦 Loading approvals...");

            // Get all purchase orders with status 'Pending Approval'
            const { data: pendingPOs, error: poError } = await supabaseClient
                .from('purchase_orders')
                .select(`
                    id,
                    po_number,
                    status,
                    supplier_id,
                    suppliers:supplier_id (name),
                    total_amount,
                    currency,
                    created_at,
                    expected_delivery_date,
                    notes
                `)
                .eq('status', 'Pending Approval')
                .order('created_at', { ascending: false });

            if (poError) throw poError;

            // Get all pending leave requests (if table exists)
            let pendingLeaves = [];
            try {
                const { data: leaves, error: leaveError } = await supabaseClient
                    .from('leave_requests')
                    .select('*')
                    .eq('status', 'pending')
                    .order('created_at', { ascending: false });

                if (!leaveError && leaves) {
                    pendingLeaves = leaves;
                }
            } catch (e) {
                console.log('ℹ️ Leave requests table not found');
            }

            // Format approvals
            const approvals = [];

            // Add pending purchase orders
            if (pendingPOs) {
                pendingPOs.forEach(po => {
                    approvals.push({
                        id: po.id,
                        ref_number: po.po_number,
                        type: 'purchase_order',
                        type_label: 'Purchase Order',
                        requester: 'System Generated',
                        date: po.created_at,
                        status: 'pending',
                        details: {
                            supplier: po.suppliers?.name || 'Unknown',
                            total: po.total_amount || 0,
                            currency: po.currency || 'USD',
                            expected_delivery: po.expected_delivery_date,
                            notes: po.notes || ''
                        }
                    });
                });
            }

            // Add pending leave requests
            pendingLeaves.forEach(leave => {
                approvals.push({
                    id: leave.id,
                    ref_number: leave.leave_id || `LEAVE-${String(leave.id).padStart(4, '0')}`,
                    type: 'leave_request',
                    type_label: 'Leave Request',
                    requester: leave.employee_name || 'Unknown',
                    date: leave.created_at,
                    status: 'pending',
                    details: {
                        leave_type: leave.leave_type || 'Annual',
                        start_date: leave.start_date,
                        end_date: leave.end_date,
                        reason: leave.reason || ''
                    }
                });
            });

            // Sort by date (newest first)
            approvals.sort((a, b) => new Date(b.date) - new Date(a.date));

            state.approvals = approvals;
            state.pendingItems = approvals.filter(a => a.status === 'pending');

            console.log(`✅ Loaded ${approvals.length} approvals (${state.pendingItems.length} pending)`);
            renderApprovals();
            updateStats();

        } catch (error) {
            console.error('Error loading approvals:', error);
            const tbody = document.getElementById('approvalTableBody');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: #dc2626;">
                    Error loading approvals: ${error.message}
                </td></tr>`;
            }
        }
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderApprovals(filtered = null) {
        const list = filtered || state.approvals;
        const tbody = document.getElementById('approvalTableBody');
        const countEl = document.getElementById('approvalCount');
        
        if (!tbody) return;
        
        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px; color: #22c55e;"></i>
                All caught up! No pending approvals.
            </td></tr>`;
            if (countEl) countEl.textContent = '0 items';
            return;
        }

        tbody.innerHTML = list.map(item => {
            const statusClass = item.status === 'pending' ? 'status-pending' : 
                              item.status === 'approved' ? 'status-approved' : 'status-rejected';
            const statusLabel = item.status.charAt(0).toUpperCase() + item.status.slice(1);
            const date = new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            
            return `
            <tr>
                <td style="padding-left: 20px; font-weight: 500;">${item.ref_number}</td>
                <td><span style="background: #e2e8f0; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem;">${item.type_label}</span></td>
                <td>${item.requester}</td>
                <td>${date}</td>
                <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                <td style="padding-right: 20px; text-align: center;">
                    ${item.status === 'pending' ? `
                        <button class="btn btn-success btn-sm" onclick="approveItem('${item.id}', '${item.type}')">
                            <i class="fa-regular fa-circle-check"></i> Approve
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="openRejectModal('${item.id}', '${item.type}')">
                            <i class="fa-solid fa-circle-xmark"></i> Reject
                        </button>
                    ` : `
                        <button class="btn btn-outline btn-sm" onclick="viewApprovalDetail('${item.id}', '${item.type}')">
                            <i class="fa-regular fa-eye"></i> View
                        </button>
                    `}
                </td>
            </tr>
            `;
        }).join('');
        
        if (countEl) countEl.textContent = `${list.length} items`;
    }

    function updateStats() {
        const pending = state.approvals.filter(a => a.status === 'pending').length;
        const approved = state.approvals.filter(a => a.status === 'approved').length;
        const rejected = state.approvals.filter(a => a.status === 'rejected').length;
        const total = state.approvals.length;

        document.getElementById('pendingCount').textContent = pending;
        document.getElementById('approvedCount').textContent = approved;
        document.getElementById('rejectedCount').textContent = rejected;
        document.getElementById('totalCount').textContent = total;
    }

    // ============================================
    // APPROVAL ACTIONS
    // ============================================

    async function approveItem(itemId, itemType) {
        if (!confirm('Are you sure you want to approve this request?')) return;

        try {
            if (itemType === 'purchase_order') {
                // Update purchase order status to 'Approved'
                const { error } = await supabaseClient
                    .from('purchase_orders')
                    .update({ 
                        status: 'Approved',
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', itemId);

                if (error) throw error;
                
                showToast('Purchase order approved successfully!', 'success');
            } else if (itemType === 'leave_request') {
                // Update leave request status
                const { error } = await supabaseClient
                    .from('leave_requests')
                    .update({ 
                        status: 'approved',
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', itemId);

                if (error) throw error;
                
                showToast('Leave request approved successfully!', 'success');
            }

            // Update local state
            const item = state.approvals.find(a => a.id === itemId && a.type === itemType);
            if (item) {
                item.status = 'approved';
            }

            renderApprovals();
            updateStats();
            await loadApprovals();

        } catch (error) {
            console.error('Error approving item:', error);
            showToast('Error approving: ' + error.message, 'error');
        }
    }

    function openRejectModal(itemId, itemType) {
        document.getElementById('rejectItemId').value = itemId;
        document.getElementById('rejectItemType').value = itemType;
        document.getElementById('rejectReason').value = '';
        document.getElementById('rejectModal').classList.add('show');
    }

    async function confirmReject() {
        const itemId = document.getElementById('rejectItemId').value;
        const itemType = document.getElementById('rejectItemType').value;
        const reason = document.getElementById('rejectReason').value.trim();

        if (!reason) {
            showToast('Please provide a reason for rejection', 'error');
            return;
        }

        try {
            if (itemType === 'purchase_order') {
                const { error } = await supabaseClient
                    .from('purchase_orders')
                    .update({ 
                        status: 'Rejected',
                        rejection_reason: reason,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', itemId);

                if (error) throw error;
                
                showToast('Purchase order rejected', 'success');
            } else if (itemType === 'leave_request') {
                const { error } = await supabaseClient
                    .from('leave_requests')
                    .update({ 
                        status: 'rejected',
                        rejection_reason: reason,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', itemId);

                if (error) throw error;
                
                showToast('Leave request rejected', 'success');
            }

            // Update local state
            const item = state.approvals.find(a => a.id === itemId && a.type === itemType);
            if (item) {
                item.status = 'rejected';
            }

            closeModal('rejectModal');
            renderApprovals();
            updateStats();
            await loadApprovals();

        } catch (error) {
            console.error('Error rejecting item:', error);
            showToast('Error rejecting: ' + error.message, 'error');
        }
    }

    async function viewApprovalDetail(itemId, itemType) {
        try {
            const item = state.approvals.find(a => a.id === itemId && a.type === itemType);
            if (!item) {
                showToast('Item not found', 'error');
                return;
            }

            const content = document.getElementById('approvalDetailContent');
            
            let detailsHtml = '';
            if (item.details) {
                Object.entries(item.details).forEach(([key, value]) => {
                    const label = key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
                    detailsHtml += `
                        <div class="approval-detail-row">
                            <span class="label">${label}</span>
                            <span class="value">${value || '-'}</span>
                        </div>
                    `;
                });
            }

            content.innerHTML = `
                <div class="approval-detail">
                    <div class="approval-detail-row">
                        <span class="label">Reference</span>
                        <span class="value"><strong>${item.ref_number}</strong></span>
                    </div>
                    <div class="approval-detail-row">
                        <span class="label">Type</span>
                        <span class="value">${item.type_label}</span>
                    </div>
                    <div class="approval-detail-row">
                        <span class="label">Requester</span>
                        <span class="value">${item.requester}</span>
                    </div>
                    <div class="approval-detail-row">
                        <span class="label">Date</span>
                        <span class="value">${new Date(item.date).toLocaleString()}</span>
                    </div>
                    <div class="approval-detail-row">
                        <span class="label">Status</span>
                        <span class="value"><span class="status-badge ${item.status === 'pending' ? 'status-pending' : item.status === 'approved' ? 'status-approved' : 'status-rejected'}">${item.status}</span></span>
                    </div>
                    ${detailsHtml}
                </div>
            `;

            document.getElementById('approvalDetailModal').classList.add('show');
        } catch (error) {
            console.error('Error viewing detail:', error);
            showToast('Error loading details: ' + error.message, 'error');
        }
    }

    // ============================================
    // FILTER FUNCTIONS
    // ============================================

    function filterApprovals() {
        const typeFilter = document.getElementById('approvalFilterType').value;
        const statusFilter = document.getElementById('approvalFilterStatus').value;
        const searchTerm = document.getElementById('approvalSearch').value.toLowerCase();

        let filtered = state.approvals;

        if (typeFilter !== 'all') {
            filtered = filtered.filter(a => a.type === typeFilter);
        }

        if (statusFilter !== 'all') {
            filtered = filtered.filter(a => a.status === statusFilter);
        }

        if (searchTerm) {
            filtered = filtered.filter(a => 
                a.ref_number.toLowerCase().includes(searchTerm) ||
                a.requester.toLowerCase().includes(searchTerm)
            );
        }

        renderApprovals(filtered);
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
    }

    function refreshApprovals() {
        loadApprovals();
        showToast('Refreshing approvals...', 'success');
    }

    function showToast(message, type = 'success') {
        const existing = document.querySelector('#customToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'customToast';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px; 
            padding: 16px 24px; border-radius: 8px; 
            color: white; font-weight: 500; z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
            background: ${type === 'success' ? '#059669' : '#dc2626'};
            max-width: 400px;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ============================================
    // TOAST CSS
    // ============================================
    if (!document.getElementById('customToastStyles')) {
        const style = document.createElement('style');
        style.id = 'customToastStyles';
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================

    function setupEventListeners() {
        // Close modals with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.show').forEach(modal => {
                    modal.classList.remove('show');
                });
            }
        });

        // Click outside modal to close
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('show');
                }
            });
        });

        // Filter listeners
        document.getElementById('approvalFilterType').addEventListener('change', filterApprovals);
        document.getElementById('approvalFilterStatus').addEventListener('change', filterApprovals);
        document.getElementById('approvalSearch').addEventListener('input', filterApprovals);
    }

    // ============================================
    // EXPOSE TO GLOBAL SCOPE
    // ============================================
    window.approveItem = approveItem;
    window.openRejectModal = openRejectModal;
    window.confirmReject = confirmReject;
    window.viewApprovalDetail = viewApprovalDetail;
    window.closeModal = closeModal;
    window.refreshApprovals = refreshApprovals;
    window.showToast = showToast;

    // ============================================
    // INITIALIZE
    // ============================================
    await loadApprovals();
    setupEventListeners();
    
    console.log("✅ Approval Queue module initialized successfully!");
})();