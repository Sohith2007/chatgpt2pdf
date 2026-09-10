/**
 * ChatGPT2PDF — Popup Script
 *
 * Handles settings persistence and triggering the export via the content script.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const DEFAULTS = {
    theme: 'light',
    pageSize: 'A4',
    timestamps: true,
    reasoning: true,
    includeTools: false,
  };

  /* ── Load saved settings ── */
  chrome.storage.local.get(DEFAULTS, (opts) => {
    const themeRadio = document.querySelector(`input[name="theme"][value="${opts.theme}"]`);
    if (themeRadio) themeRadio.checked = true;

    const pageRadio = document.querySelector(`input[name="pageSize"][value="${opts.pageSize}"]`);
    if (pageRadio) pageRadio.checked = true;

    $('timestamps').checked = opts.timestamps;
    $('reasoning').checked = opts.reasoning;
    $('includeTools').checked = opts.includeTools;
  });

  /* ── Auto-detect OS dark mode for first-time default ── */
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    chrome.storage.local.get({ _themeSet: false }, (r) => {
      if (!r._themeSet) {
        const darkRadio = document.querySelector('input[name="theme"][value="dark"]');
        if (darkRadio) darkRadio.checked = true;
        chrome.storage.local.set({ theme: 'dark', _themeSet: true });
      }
    });
  }

  /* ── Read current values & persist ── */
  function saveSettings() {
    const themeEl = document.querySelector('input[name="theme"]:checked');
    const pageEl = document.querySelector('input[name="pageSize"]:checked');
    const vals = {
      theme: themeEl ? themeEl.value : 'light',
      pageSize: pageEl ? pageEl.value : 'A4',
      timestamps: $('timestamps').checked,
      reasoning: $('reasoning').checked,
      includeTools: $('includeTools').checked,
    };
    chrome.storage.local.set(vals);
    return vals;
  }

  /* Listen for any change in settings */
  document.addEventListener('change', (e) => {
    if (e.target.matches('input[name="theme"], input[name="pageSize"], #timestamps, #reasoning, #includeTools')) {
      saveSettings();
    }
  });

  /* ── Status helpers ── */
  const statusEl = $('status');
  function showStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  /* ── Export button ── */
  const btn = $('export-btn');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    showStatus('Exporting…');

    const opts = saveSettings();

    try {
      // Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab found');

      // Check if we're on a ChatGPT page
      const url = tab.url || '';
      if (!/chatgpt\.com|chat\.openai\.com/i.test(url)) {
        throw new Error('Navigate to a ChatGPT conversation first.');
      }

      // Send message to content script
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'export',
        options: opts,
      });

      if (response && response.ok) {
        showStatus('✓ Export opened in new tab!', 'success');
        setTimeout(() => {
          showStatus('');
          btn.disabled = false;
        }, 2500);
      } else {
        throw new Error((response && response.error) || 'Export failed');
      }
    } catch (err) {
      // Handle "Could not establish connection" — content script not injected
      const msg = err.message || String(err);
      if (msg.includes('Could not establish connection') || msg.includes('Receiving end does not exist')) {
        showStatus('⚠ Refresh the ChatGPT page first, then try again.', 'error');
      } else {
        showStatus(msg, 'error');
      }
      btn.disabled = false;
    }
  });
})();
