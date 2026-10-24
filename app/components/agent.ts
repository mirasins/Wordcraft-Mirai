import './controls/key_command_small';

import {MobxLitElement} from '@adobe/lit-mobx';
import {css, html} from 'lit';
import {customElement} from 'lit/decorators.js';

import {wordcraftCore} from '@core/wordcraft_core';
import {
  AGENT_MAX_MESSAGE_CHARS,
  AgentService,
} from '@services/agent_service';

import {styles} from './chat.css';
import {styles as sharedStyles} from './shared.css';

/**
 * Conversation UI for the backend agent. State lives in AgentService so it
 * persists across tab switches.
 */
@customElement('wordcraft-agent')
export class AgentComponent extends MobxLitElement {
  static override get styles() {
    return [
      sharedStyles,
      styles,
      css`
        :host {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        .notice {
          font-size: 0.85em;
          color: var(--text-muted);
          margin-bottom: 8px;
        }
        .error {
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 6px 8px;
          margin-bottom: 8px;
          font-size: 0.9em;
        }
        .tools {
          font-size: 0.75em;
          color: var(--text-muted);
          margin-bottom: 8px;
        }
        .input-container {
          margin-top: 8px;
        }
        .actions {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        .actions button {
          padding: 4px 10px;
        }
      `,
    ];
  }

  private readonly agentService = wordcraftCore.getService(AgentService);
  private nMessages = -1;

  override connectedCallback() {
    super.connectedCallback();
    if (!this.agentService.health && !this.agentService.isCheckingHealth) {
      this.agentService.checkHealth();
    }
  }

  override updated() {
    const count =
      this.agentService.messages.length +
      (this.agentService.pendingMessage ? 1 : 0);
    if (count !== this.nMessages) {
      const container = this.shadowRoot!.querySelector('.messages-container');
      if (container) container.scrollTop = container.scrollHeight;
      this.nMessages = count;
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    // Enter envía; Shift+Enter inserta salto de línea.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.agentService.canSend) this.agentService.send();
    }
  };

  private renderStatus() {
    const s = this.agentService;
    const {health, healthError, isCheckingHealth} = s;
    const recheck = html`<button
      type="button"
      ?disabled=${isCheckingHealth}
      @click=${this.onRecheck}
    >
      Comprobar conexión
    </button>`;

    if (isCheckingHealth && !health) {
      return html`<div class="notice">Comprobando conexión con Claude…</div>`;
    }
    if (healthError) {
      return html`<div class="error">
        No se pudo contactar con el servidor de agentes: ${healthError}
        <div class="actions">${recheck}</div>
      </div>`;
    }
    if (health && !health.ready) {
      return html`<div class="error">
        ${health.cliInstalled === false
          ? html`Claude Code no está instalado en el equipo del servidor.
              Instálalo con el instalador nativo: en PowerShell
              <code>irm https://claude.ai/install.ps1 | iex</code>; en
              macOS/Linux <code>curl -fsSL https://claude.ai/install.sh | bash</code>.
              Después ejecuta <code>claude auth login</code> con tu cuenta de
              Claude y pulsa «Comprobar conexión».`
          : html`Claude no está conectado: hace falta iniciar sesión con tu
              cuenta.`}
        ${this.renderLogin(health.cliInstalled !== false)}
        <div class="actions">${recheck}</div>
      </div>`;
    }
    if (health) {
      return html`<div class="notice">
        Conectado con tu cuenta de Claude · modelo ${health.model}
      </div>`;
    }
    return html``;
  }

  private renderLogin(canLogin: boolean) {
    const s = this.agentService;
    if (!canLogin) return html``;
    return html`
      <div class="actions">
        <button
          type="button"
          ?disabled=${s.isStartingLogin}
          @click=${() => s.startLogin()}
        >
          Iniciar sesión en Claude
        </button>
      </div>
      ${s.loginStarted || s.loginMessage
        ? html`<div class="notice">
            ${s.loginMessage ?? 'Inicio de sesión solicitado.'}
            ${s.loginUrl
              ? html`<br /><a href=${s.loginUrl} target="_blank" rel="noopener noreferrer">Abrir página de inicio de sesión de Claude</a>`
              : ''}
            <br />
            ${s.loginStarted
              ? html`Si el navegador no se abre solo, ejecuta
                  <code>claude auth login</code> en tu propia terminal. Cuando
                  termines, pulsa «Comprobar conexión».`
              : ''}
            Esta página nunca ve tu contraseña ni tokens.
          </div>`
        : ''}
      ${s.loginError
        ? html`<div class="error" role="alert">${s.loginError}</div>`
        : ''}
    `;
  }
  private readonly onRecheck = (e: Event) => {
    e.preventDefault();
    this.agentService.checkHealth();
  };

  override render() {
    const s = this.agentService;
    const canSend = s.canSend;

    // clang-format off
    return html`
      <div class="messages-container">
        <div class="notice">
          El agente usa tu cuenta de Claude (Claude Code) y solo lee el documento (vía MCP). En esta versión no aplica
          ediciones: tú decides qué copiar al texto. Cada mensaje envía una
          copia del texto actual del documento.
        </div>
        ${this.renderStatus()}
        ${s.messages.map((m) => this.renderMessage(m.role, m.content, m.toolCalls))}
        ${s.pendingMessage ? this.renderMessage('user', s.pendingMessage) : ''}
        ${s.isBusy
          ? html`<div class="left-side-msg"><div class="bubble-text agent-msg" role="status" aria-label="Cargando respuesta">
              <div class="loading-wrapper"><div class="dot-flashing"></div></div>
            </div></div>`
          : ''}
        ${s.documentTruncated
          ? html`<div class="notice">El documento es muy largo: se envió solo el inicio.</div>`
          : ''}
        ${s.error ? html`<div class="error" role="alert">${s.error}</div>` : ''}
      </div>
      <div class="input-container">
        <textarea
          ?disabled=${s.isBusy}
          maxlength=${AGENT_MAX_MESSAGE_CHARS}
          class="text-input"
          aria-label="Mensaje para el agente"
          placeholder="Pregunta al agente sobre tu texto… (Mayús+Intro para nueva línea)"
          .value=${s.draft}
          @keydown=${this.onKeyDown}
          @input=${(e: Event) =>
            s.setDraft((e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="actions">
          <button type="button" ?disabled=${!canSend} @click=${() => s.send()}>
            ${s.error && !s.isBusy ? 'Reintentar' : 'Enviar'}
          </button>
          <button type="button" ?disabled=${!s.isBusy} @click=${() => s.cancel()}>
            Dejar de esperar
          </button>
          <button type="button" ?disabled=${s.isBusy} @click=${() => s.reset()}>
            Nueva conversación
          </button>
        </div>
      </div>
    `;
    // clang-format on
  }

  private renderMessage(role: string, content: string, tools?: string[]) {
    const isUser = role === 'user';
    return html`
      <div class=${isUser ? 'right-side-msg' : 'left-side-msg'}>
        <div class="bubble-text ${isUser ? 'usr-msg' : 'agent-msg'}">
          ${content}
        </div>
      </div>
      ${tools && tools.length
        ? html`<div class="tools">Herramientas usadas: ${tools.join(', ')}</div>`
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'wordcraft-agent': AgentComponent;
  }
}
