/**
 * Kovv-ia Telegram Bridge
 * -----------------------
 * Connects a Telegram bot to a locally running Kovv-ia instance via long polling.
 * Zero npm dependencies — uses Node.js built-in fetch (Node >= 18) and fs/promises.
 *
 * Run:  node --env-file tools/telegram-bridge/.env tools/telegram-bridge/bridge.mjs
 * List: node tools/telegram-bridge/bridge.mjs --list
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// CLI: --list mode (no Telegram needed, just discovers Kovv-ia IDs)
// ---------------------------------------------------------------------------

const isListMode = process.argv.includes('--list');

if (isListMode) {
  await runListMode();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config — all from process.env (loaded via --env-file)
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN        ?? '';
const TELEGRAM_ALLOWED_RAW     = process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '';
const KOVV_API                 = process.env.KOVV_API                  ?? 'http://127.0.0.1:3100/api';
const KOVV_COMPANY_ID          = process.env.KOVV_COMPANY_ID           ?? '';
const KOVV_AGENT_ID            = process.env.KOVV_AGENT_ID            ?? '';
const KOVV_PROJECT_ID          = process.env.KOVV_PROJECT_ID           ?? '';
const POLL_INTERVAL_MS         = Number(process.env.POLL_INTERVAL_MS   ?? 3000);
const STATE_FILE               = process.env.STATE_FILE                ?? 'tools/telegram-bridge/state.json';

// Parse allowlist
const ALLOWED_CHAT_IDS = TELEGRAM_ALLOWED_RAW
  ? new Set(TELEGRAM_ALLOWED_RAW.split(',').map(s => s.trim()).filter(Boolean))
  : null; // null = open (warn but allow)

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

const REQUIRED = {
  TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN,
  KOVV_COMPANY_ID:    KOVV_COMPANY_ID,
  KOVV_AGENT_ID:      KOVV_AGENT_ID,
};

const missing = Object.entries(REQUIRED)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error('');
  console.error('❌  Variables d\'environnement manquantes :');
  missing.forEach(k => console.error(`    - ${k}`));
  console.error('');
  console.error('👉  Copiez tools/telegram-bridge/.env.example vers tools/telegram-bridge/.env');
  console.error('    et renseignez les valeurs manquantes.');
  console.error('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║       Kovv-ia — Pont Telegram               ║');
console.log('╚══════════════════════════════════════════════╝');
console.log(`  API Kovv-ia  : ${KOVV_API}`);
console.log(`  Entreprise   : ${KOVV_COMPANY_ID}`);
console.log(`  Agent        : ${KOVV_AGENT_ID}`);
console.log(`  Projet       : ${KOVV_PROJECT_ID || '(aucun)'}`);
console.log(`  Intervalle   : ${POLL_INTERVAL_MS} ms`);
console.log(`  État (fichier): ${STATE_FILE}`);

if (!ALLOWED_CHAT_IDS) {
  console.warn('');
  console.warn('⚠️  ATTENTION : TELEGRAM_ALLOWED_CHAT_IDS n\'est pas défini.');
  console.warn('   Le bot acceptera des messages de N\'IMPORTE QUEL utilisateur Telegram.');
  console.warn('   Pour restreindre l\'accès, ajoutez vos IDs dans TELEGRAM_ALLOWED_CHAT_IDS.');
} else {
  console.log(`  Accès autorisé: ${[...ALLOWED_CHAT_IDS].join(', ')}`);
}

console.log('');
console.log('✅  Démarrage du pont Telegram…');
console.log('');

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

/**
 * @typedef {{ issueId: string, identifier: string, lastCommentId: string|null, doneNotified: boolean }} ChatState
 * @typedef {{ chats: Record<string, ChatState>, telegramOffset: number }} BridgeState
 */

/** @type {BridgeState} */
let state = { chats: {}, telegramOffset: 0 };

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Basic shape validation
    if (parsed && typeof parsed === 'object' && parsed.chats) {
      state = parsed;
      console.log(`📂  État chargé : ${Object.keys(state.chats).length} conversation(s) active(s).`);
    }
  } catch {
    console.log('📂  Pas d\'état précédent trouvé — démarrage à zéro.');
  }
}

async function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, STATE_FILE);
  } catch (err) {
    console.error('⚠️  Impossible de sauvegarder l\'état :', err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Generic fetch with timeout and error normalization.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function fetchJSON(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

const TG = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/**
 * Call a Telegram Bot API method.
 * @param {string} method
 * @param {Record<string, any>} [params]
 * @param {number} [timeoutMs]
 */
async function tgCall(method, params = {}, timeoutMs = 35_000) {
  const url = `${TG}/${method}`;
  return fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }, timeoutMs);
}

/**
 * Send a text message to a Telegram chat.
 * Long messages are split into <=4096-char chunks.
 * @param {string|number} chatId
 * @param {string} text
 */
async function tgSend(chatId, text) {
  const MAX = 4096;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX));
    remaining = remaining.slice(MAX);
  }
  for (const chunk of chunks) {
    await tgCall('sendMessage', { chat_id: chatId, text: chunk });
  }
}

/**
 * Send a "typing…" chat action.
 * @param {string|number} chatId
 */
async function tgTyping(chatId) {
  await tgCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Kovv-ia API helpers
// ---------------------------------------------------------------------------

/**
 * Create a new issue (starts a new conversation thread).
 * @param {string} title
 * @param {string} description
 * @returns {Promise<{id: string, identifier: string}>}
 */
async function kovvCreateIssue(title, description) {
  const body = {
    title,
    description,
    status: 'todo',
    assigneeAgentId: KOVV_AGENT_ID,
  };
  if (KOVV_PROJECT_ID) body.projectId = KOVV_PROJECT_ID;

  return fetchJSON(
    `${KOVV_API}/companies/${KOVV_COMPANY_ID}/issues`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    15_000,
  );
}

/**
 * Append a human follow-up comment to an existing issue.
 * @param {string} issueId
 * @param {string} body
 */
async function kovvAddComment(issueId, body) {
  return fetchJSON(
    `${KOVV_API}/issues/${issueId}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
    15_000,
  );
}

/**
 * Fetch comments newer than lastCommentId (or all if null).
 * @param {string} issueId
 * @param {string|null} lastCommentId
 * @returns {Promise<Array>}
 */
async function kovvGetNewComments(issueId, lastCommentId) {
  let url = `${KOVV_API}/issues/${issueId}/comments?order=asc&limit=200`;
  if (lastCommentId) url += `&after=${encodeURIComponent(lastCommentId)}`;
  return fetchJSON(url, {}, 15_000);
}

/**
 * Get issue details (for status checks).
 * @param {string} issueId
 */
async function kovvGetIssue(issueId) {
  return fetchJSON(`${KOVV_API}/issues/${issueId}`, {}, 10_000);
}

// ---------------------------------------------------------------------------
// Allowlist guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the chat is allowed to interact with this bot.
 * @param {string|number} chatId
 * @param {string} username
 */
function isChatAllowed(chatId, username) {
  if (!ALLOWED_CHAT_IDS) {
    console.log(`ℹ️  Message reçu de chat_id=${chatId} (${username || 'inconnu'}) — bot ouvert.`);
    return true;
  }
  return ALLOWED_CHAT_IDS.has(String(chatId));
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const GREETING = `👋 Bonjour ! Je suis le pont entre Telegram et l'agent Kovv-ia.

• Écrivez simplement votre message et l'agent vous répondra ici.
• /nouveau — commencer une nouvelle conversation (efface le fil en cours).
• /id      — afficher votre identifiant Telegram (chat ID).
• /aide    — afficher ce message d'aide.`;

/**
 * Handle an incoming Telegram update.
 * @param {{ message?: any }} update
 */
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return; // ignore non-message updates (edits, channel posts, etc.)

  const chatId = String(msg.chat.id);
  const username = msg.from?.username ?? msg.from?.first_name ?? 'inconnu';
  const text = msg.text ?? '';

  // Only handle text messages
  if (!msg.text) {
    await tgSend(chatId, '⚠️  Je ne traite que les messages texte pour l\'instant.');
    return;
  }

  // Allowlist check
  if (!isChatAllowed(chatId, username)) {
    await tgSend(
      chatId,
      `🚫 Accès refusé.\n\nVotre chat ID est : ${chatId}\nDemandez à l'administrateur de l'ajouter dans TELEGRAM_ALLOWED_CHAT_IDS.`,
    );
    return;
  }

  // Commands
  if (text === '/start' || text === '/aide' || text.startsWith('/start ') || text.startsWith('/aide ')) {
    await tgSend(chatId, GREETING);
    return;
  }

  if (text === '/id') {
    await tgSend(chatId, `🪪  Votre chat ID Telegram est : ${chatId}`);
    return;
  }

  if (text === '/nouveau') {
    if (state.chats[chatId]) {
      delete state.chats[chatId];
      await saveState();
      await tgSend(chatId, '🔄  Conversation réinitialisée. Votre prochain message créera un nouveau fil.');
    } else {
      await tgSend(chatId, '🔄  Aucun fil actif — vous êtes déjà prêt à démarrer une nouvelle conversation.');
    }
    return;
  }

  if (text.startsWith('/')) {
    await tgSend(chatId, `❓  Commande inconnue : ${text}\n\nTapez /aide pour la liste des commandes disponibles.`);
    return;
  }

  // Regular message — send to Kovv-ia
  await tgTyping(chatId);

  if (!state.chats[chatId]) {
    // No active thread → create a new issue
    const title = text.slice(0, 60).trim() || `Telegram — ${new Date().toLocaleDateString('fr-FR')}`;
    try {
      const issue = await kovvCreateIssue(title, text);
      state.chats[chatId] = {
        issueId:       issue.id,
        identifier:    issue.identifier ?? issue.id,
        lastCommentId: null,
        doneNotified:  false,
      };
      await saveState();
      console.log(`📝  Nouveau fil créé : ${issue.identifier ?? issue.id} pour chat_id=${chatId}`);
      await tgSend(chatId, `📨  Reçu — l'agent va répondre… (fil : ${issue.identifier ?? issue.id})`);
    } catch (err) {
      console.error(`❌  Impossible de créer un fil Kovv-ia pour chat_id=${chatId} :`, err.message);
      await tgSend(chatId, '⚠️  Kovv-ia est injoignable (le serveur tourne-t-il sur 3100 ?)');
    }
  } else {
    // Existing thread → add a comment
    const { issueId, identifier } = state.chats[chatId];
    try {
      await kovvAddComment(issueId, text);
      console.log(`💬  Commentaire ajouté au fil ${identifier} pour chat_id=${chatId}`);
      await tgSend(chatId, `📨  Reçu — l'agent va répondre…`);
    } catch (err) {
      console.error(`❌  Impossible d'ajouter un commentaire au fil ${identifier} :`, err.message);
      await tgSend(chatId, '⚠️  Kovv-ia est injoignable (le serveur tourne-t-il sur 3100 ?)');
    }
  }
}

// ---------------------------------------------------------------------------
// Telegram long-polling loop
// ---------------------------------------------------------------------------

let pollingActive = true;

async function pollTelegram() {
  while (pollingActive) {
    try {
      const result = await tgCall(
        'getUpdates',
        { offset: state.telegramOffset, timeout: 30, allowed_updates: ['message'] },
        35_000,
      );

      if (result?.ok && Array.isArray(result.result) && result.result.length > 0) {
        for (const update of result.result) {
          await handleUpdate(update);
          // Advance offset past this update so it is not redelivered
          state.telegramOffset = update.update_id + 1;
        }
        await saveState();
      }
    } catch (err) {
      if (!pollingActive) break;
      console.error('⚠️  Erreur de polling Telegram :', err.message, '— nouvelle tentative dans 5 s…');
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
}

// ---------------------------------------------------------------------------
// Reply relay polling loop (agent responses → Telegram)
// ---------------------------------------------------------------------------

let relayInFlight = false;

async function relayAgentReplies() {
  // Re-entrancy guard: setInterval does not wait for the previous async pass.
  // Without this, a slow send (long agent reply split into many chunks) could
  // overlap with the next tick and re-send the same comments before
  // lastCommentId is advanced.
  if (relayInFlight) return;
  relayInFlight = true;
  try {
    await relayAgentRepliesInner();
  } finally {
    relayInFlight = false;
  }
}

async function relayAgentRepliesInner() {
  // Snapshot active chats to avoid mutation during iteration
  const entries = Object.entries(state.chats);
  if (entries.length === 0) return;

  for (const [chatId, chat] of entries) {
    try {
      const comments = await kovvGetNewComments(chat.issueId, chat.lastCommentId);
      if (!Array.isArray(comments) || comments.length === 0) continue;

      // Advance lastCommentId across ALL returned comments (avoids re-fetching)
      const newestId = comments[comments.length - 1].id;

      let relayed = 0;
      for (const comment of comments) {
        // Only relay agent comments (authorAgentId non-null)
        if (comment.authorAgentId) {
          await tgSend(chatId, comment.body ?? '');
          relayed++;
        }
      }

      if (relayed > 0) {
        console.log(`📤  ${relayed} réponse(s) relayée(s) au chat_id=${chatId} (fil ${chat.identifier})`);
      }

      state.chats[chatId].lastCommentId = newestId;

      // Check if the issue reached a terminal state
      if (!chat.doneNotified) {
        try {
          const issue = await kovvGetIssue(chat.issueId);
          if (issue?.status === 'done' || issue?.status === 'cancelled') {
            const emoji = issue.status === 'done' ? '✅' : '🚫';
            await tgSend(chatId, `${emoji}  (l'agent a terminé cette tâche — tapez /nouveau pour ouvrir un nouveau fil)`);
            state.chats[chatId].doneNotified = true;
            console.log(`🏁  Fil ${chat.identifier} terminé (${issue.status}) — notification envoyée.`);
          }
        } catch {
          // Non-fatal: status check failure should not interrupt relay
        }
      }

      await saveState();
    } catch (err) {
      console.error(`⚠️  Erreur de relai pour chat_id=${chatId} (fil ${chat.identifier}) :`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// --list mode: discover Kovv-ia companies, agents, projects
// ---------------------------------------------------------------------------

async function runListMode() {
  const baseUrl = process.env.KOVV_API ?? 'http://127.0.0.1:3100/api';
  console.log('');
  console.log(`🔍  Connexion à Kovv-ia sur ${baseUrl}…`);
  console.log('');

  let companies;
  try {
    companies = await fetchJSON(`${baseUrl}/companies`, {}, 10_000);
  } catch (err) {
    console.error('❌  Impossible de joindre Kovv-ia :', err.message);
    console.error('    Vérifiez que le serveur tourne (port 3100) et que KOVV_API est correct.');
    process.exit(1);
  }

  if (!Array.isArray(companies) || companies.length === 0) {
    console.log('ℹ️  Aucune entreprise trouvée dans Kovv-ia.');
    return;
  }

  for (const company of companies) {
    console.log(`┌─ Entreprise : ${company.name}`);
    console.log(`│  id         : ${company.id}`);
    console.log('│');

    // Agents
    try {
      const agents = await fetchJSON(`${baseUrl}/companies/${company.id}/agents`, {}, 10_000);
      if (Array.isArray(agents) && agents.length > 0) {
        console.log('│  Agents :');
        for (const agent of agents) {
          console.log(`│    • ${agent.name.padEnd(20)} id=${agent.id}  rôle=${agent.role ?? '—'}  statut=${agent.status ?? '—'}`);
        }
      } else {
        console.log('│  Agents : (aucun)');
      }
    } catch (err) {
      console.log(`│  Agents : ⚠️  erreur — ${err.message}`);
    }

    console.log('│');

    // Projects
    try {
      const projects = await fetchJSON(`${baseUrl}/companies/${company.id}/projects`, {}, 10_000);
      if (Array.isArray(projects) && projects.length > 0) {
        console.log('│  Projets :');
        for (const project of projects) {
          console.log(`│    • ${project.name.padEnd(20)} id=${project.id}`);
        }
      } else {
        console.log('│  Projets : (aucun)');
      }
    } catch (err) {
      console.log(`│  Projets : ⚠️  erreur — ${err.message}`);
    }

    console.log('└─────────────────────────────────────────────────────────');
    console.log('');
  }

  console.log('👉  Copiez les IDs ci-dessus dans votre fichier .env :');
  console.log('      KOVV_COMPANY_ID=<id de l\'entreprise>');
  console.log('      KOVV_AGENT_ID=<id de l\'agent>');
  console.log('      KOVV_PROJECT_ID=<id du projet>  (optionnel)');
  console.log('');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.log('');
  console.log(`🛑  Signal ${signal} reçu — arrêt propre en cours…`);
  pollingActive = false;
  await saveState();
  console.log('💾  État sauvegardé. Au revoir !');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await loadState();

// Start Telegram long-polling (runs until pollingActive = false)
pollTelegram(); // intentionally not awaited — runs in background

// Start relay loop
setInterval(relayAgentReplies, POLL_INTERVAL_MS);

// Run one relay pass immediately at startup (catch any pending replies)
relayAgentReplies();

console.log('🤖  Bot actif. Envoyez un message sur Telegram pour commencer.');
console.log('    Ctrl+C pour arrêter proprement.');
console.log('');
