// ============================================
// SECUGEN WEBAPI HELPER (fingerprint reader)
// ============================================
// Talks to the SecuGen WebAPI Client -- a small background program
// that must be installed and running on THIS SPECIFIC PC, the one the
// SecuGen HUPx (Hamster Pro) reader is physically plugged into. That
// program exposes the reader to the browser as a tiny local web
// service; this file is just the JS side of calling it. Nothing here
// talks to the USB reader directly -- browsers can't do that, which
// is exactly why SecuGen WebAPI exists.
//
// If these calls fail with a network/connection error (not a
// fingerprint error), it almost always means the SecuGen WebAPI
// Client isn't installed or isn't running on this PC yet -- see the
// error messages below, which say this explicitly.
//
// Loaded globally (same pattern as shared-attendance-utils.js):
// included via a <script> tag in root index.html, so every SPA
// sub-module can call these functions directly, no import needed.
// ============================================

// 🔧 SETUP: once you have a SecuGen WebAPI license key for the domain
// this ERP is served from, paste it here. Leave it as '' to use
// SecuGen's 60-day free trial while testing -- it works without a key
// for that trial window, per SecuGen's own WebAPI documentation.
const SECUGEN_LICENSE_KEY = '';

// Default install -- SecuGen WebAPI Client listens on this local port.
// Configurable during their installer if it's ever changed.
const SECUGEN_WEBAPI_BASE = 'https://localhost:8000';

// SGIMatchScore returns 0-199. This is a starting threshold, not a
// certainty -- test it with your own staff's fingers and adjust up
// (stricter / fewer false matches) or down (more forgiving) based on
// what actually happens at the kiosk. SecuGen's own guidance is that
// higher is stricter; this value errs on the stricter side on
// purpose, since a wrong match means clocking in the WRONG employee.
const FINGERPRINT_MATCH_THRESHOLD = 60;

// When identifying "whose finger is this" by comparing against every
// enrolled employee, the best match also has to beat the SECOND-best
// match by at least this many points. If two employees' scores come
// back close together, we refuse to guess -- better to ask the person
// to re-scan (or use Manual Entry) than silently clock in the wrong
// person.
const FINGERPRINT_AMBIGUOUS_MARGIN = 15;

/**
 * Captures one fingerprint scan from the reader attached to this PC.
 * Returns { ok: true, template } on success, or
 * { ok: false, errorMessage } if the scan/service failed.
 */
async function captureFingerprint(timeoutMs = 10000) {
    const params = new URLSearchParams({
        Timeout: String(timeoutMs),
        TemplateFormat: 'ISO',
        ImageWSQRate: '0.75',
    });
    if (SECUGEN_LICENSE_KEY) params.set('Licstr', SECUGEN_LICENSE_KEY);

    let response;
    try {
        response = await fetch(`${SECUGEN_WEBAPI_BASE}/SGIFPCapture?${params.toString()}`, {
            method: 'GET',
        });
    } catch (networkError) {
        return {
            ok: false,
            errorMessage: 'Could not reach the fingerprint reader service on this PC. ' +
                'Make sure the SecuGen WebAPI Client is installed and running here, ' +
                'and that the reader is plugged in.',
        };
    }

    if (!response.ok) {
        return { ok: false, errorMessage: `Fingerprint service returned an error (HTTP ${response.status}).` };
    }

    let data;
    try {
        data = await response.json();
    } catch (parseError) {
        return { ok: false, errorMessage: 'Fingerprint service returned an unexpected response.' };
    }

    // ErrorCode 0 = success, per SecuGen's WebAPI documentation.
    if (data.ErrorCode && data.ErrorCode !== 0) {
        return { ok: false, errorMessage: `Fingerprint capture failed (code ${data.ErrorCode}). Please try again.` };
    }
    if (!data.TemplateBase64 && !data.Template) {
        return { ok: false, errorMessage: 'No fingerprint template returned. Please try scanning again.' };
    }

    return { ok: true, template: data.TemplateBase64 || data.Template };
}

/**
 * Compares two base64 ISO templates and returns a numeric match score
 * (0-199, higher = more similar), or null if the comparison itself
 * failed (e.g. the WebAPI client isn't reachable).
 */
async function matchFingerprintTemplates(template1, template2) {
    const params = new URLSearchParams({ TemplateFormat: 'ISO' });
    if (SECUGEN_LICENSE_KEY) params.set('Licstr', SECUGEN_LICENSE_KEY);

    let response;
    try {
        response = await fetch(`${SECUGEN_WEBAPI_BASE}/SGIMatchScore?${params.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Template1: template1, Template2: template2 }),
        });
    } catch (networkError) {
        return null;
    }

    if (!response.ok) return null;

    let data;
    try {
        data = await response.json();
    } catch (parseError) {
        return null;
    }

    if (data.ErrorCode && data.ErrorCode !== 0) return null;
    const score = data.MatchingScore;
    return typeof score === 'number' ? score : null;
}

/**
 * Given a freshly-captured template and a list of enrolled candidates
 * ({ employee_id, template, ...anything else you want back }), finds
 * the single best match. Returns:
 *   { matched: true, candidate, score }
 *   { matched: false, reason: 'no_match' | 'ambiguous', bestScore, secondScore }
 */
async function identifyFingerprint(capturedTemplate, candidates) {
    let best = null, bestScore = -Infinity;
    let secondScore = -Infinity;

    for (const candidate of candidates) {
        const score = await matchFingerprintTemplates(capturedTemplate, candidate.template);
        if (score === null) continue;
        if (score > bestScore) {
            secondScore = bestScore;
            bestScore = score;
            best = candidate;
        } else if (score > secondScore) {
            secondScore = score;
        }
    }

    if (!best || bestScore < FINGERPRINT_MATCH_THRESHOLD) {
        return { matched: false, reason: 'no_match', bestScore, secondScore };
    }
    if (bestScore - secondScore < FINGERPRINT_AMBIGUOUS_MARGIN) {
        return { matched: false, reason: 'ambiguous', bestScore, secondScore };
    }
    return { matched: true, candidate: best, score: bestScore };
}
