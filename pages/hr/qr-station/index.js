// ============================================
// QR CLOCK-IN STATION DISPLAY
// ============================================
// Runs on the phone/tablet left at the pharmacy. Every 30 seconds:
// generates a new random token, stores it in qr_clock_tokens with a
// short expiry, and re-renders the QR code pointing to clock-in.html
// with that token. An employee's own phone scans it, opens that
// standalone page, and the token is checked there against this table.
//
// 🔥 FIX: originally drew the QR code with a JS library loaded from a
// CDN, which failed if that CDN was unreachable on the network the
// station's phone was using. Switched to a URL-based QR image API
// instead -- the QR code is just an <img> pointing at a service that
// returns a PNG, no script to load or fail at all.
// ============================================

(async function initQrStation() {
    console.log("QR Clock-In Station initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const ROTATE_SECONDS = 30;
    const TOKEN_VALID_SECONDS = 45; // slightly longer than rotation, so a scan mid-cycle doesn't fail

    function generateToken() {
        return Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function rotateToken() {
        const token = generateToken();
        const expiresAt = new Date(Date.now() + TOKEN_VALID_SECONDS * 1000).toISOString();

        const { error } = await supabaseClient.from('qr_clock_tokens').insert([{ token, expires_at: expiresAt }]);
        if (error) {
            console.error('Error creating QR token:', error);
            const container = document.getElementById('qrCodeContainer');
            if (container) container.innerHTML = `<p style="color:#dc2626; font-size:0.85rem;">Error creating code: ${error.message}</p>`;
            return;
        }

        // Light housekeeping -- clear out old expired tokens so this
        // table doesn't grow forever.
        supabaseClient.from('qr_clock_tokens').delete().lt('expires_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());

        const clockInUrl = `${window.location.origin}/clock-in.html?token=${token}`;
        const img = document.getElementById('qrImage');
        if (img) {
            img.src = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(clockInUrl)}`;
            img.onerror = () => {
                const container = document.getElementById('qrCodeContainer');
                if (container) container.innerHTML = `<p style="color:#dc2626; font-size:0.85rem;">Could not load the QR image service. Check your internet connection.</p>`;
            };
        }
    }

    let secondsLeft = ROTATE_SECONDS;
    function tickCountdown() {
        secondsLeft--;
        const el = document.getElementById('qrCountdown');
        if (el) el.textContent = Math.max(0, secondsLeft);
        if (secondsLeft <= 0) {
            secondsLeft = ROTATE_SECONDS;
            rotateToken();
        }
    }

    await rotateToken();
    setInterval(tickCountdown, 1000);
    console.log("✅ QR Clock-In Station initialized successfully!");
})();