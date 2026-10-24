/**
 * @license
 * Copyright 2023 Google LLC.
 * Licensed under the Apache License, Version 2.0
 */
import {action, computed, decorate, observable, reaction} from 'mobx';

import {AGENT_MAX_MESSAGES, AgentMessage, buildRequestMessages} from '@lib/agent_messages';
import {Service} from './service';
import {
  AppService,
  DocumentStoreService,
  TextEditorService,
} from './services';

interface ServiceProvider {
  appService: AppService;
  documentStoreService: DocumentStoreService;
  textEditorService: TextEditorService;
}

export type {AgentMessage};

export interface AgentHealth {
  ready: boolean;
  provider: string;
  model: string;
  loginRequired?: boolean;
  cliInstalled?: boolean;
}

export const AGENT_MAX_MESSAGE_CHARS = 4000;
export const AGENT_MAX_DOCUMENT_CHARS = 60000;

const AGENT_API = '/api/agent';

class AgentHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Manages a conversation with the backend agent. The conversation lives here
 * (not in the component) so it survives sidebar tab switches, and is cleared
 * whenever the document changes or the editor is left.
 */
export class AgentService extends Service {
  constructor(private readonly serviceProvider: ServiceProvider) {
    super();
    this.lastDocumentId = serviceProvider.documentStoreService.documentId;
    reaction(
      () =>
        [
          this.serviceProvider.appService.lifeCycleState,
          this.serviceProvider.documentStoreService.documentId,
        ] as [string, string | null],
      ([lifeCycle, documentId]) => {
        const prevDocumentId = this.lastDocumentId;
        this.lastDocumentId = documentId;
        // null -> id (first autosave of a new story) is the same document.
        const switchedDocument =
          prevDocumentId != null && documentId !== prevDocumentId;
        if (lifeCycle !== 'EDITING' || switchedDocument) {
          this.reset();
        }
      }
    );
  }

  messages: AgentMessage[] = [];
  draft = '';
  pendingMessage: string | null = null;
  isBusy = false;
  error: string | null = null;
  health: AgentHealth | null = null;
  healthError: string | null = null;
  isCheckingHealth = false;
  documentTruncated = false;
  isStartingLogin = false;
  loginStarted = false;
  loginMessage: string | null = null;
  loginUrl: string | null = null;
  loginError: string | null = null;

  private abortController: AbortController | null = null;
  private lastDocumentId: string | null = null;
  private epoch = 0;
  private healthEpoch = 0;
  private loginToken = 0;

  /** Whether a message can be sent right now (ready, idle, non-empty draft). */
  get canSend() {
    return (
      !this.isBusy && this.draft.trim().length > 0 && this.health?.ready === true
    );
  }

  setDraft(value: string) {
    this.draft = value;
  }

  async checkHealth() {
    const healthEpoch = ++this.healthEpoch;
    this.isCheckingHealth = true;
    try {
      const res = await fetch(`${AGENT_API}/health`);
      const data = await this.parse(res);
      if (healthEpoch !== this.healthEpoch) return;
      this.health = data as AgentHealth;
      this.healthError = null;
    } catch (e) {
      if (healthEpoch !== this.healthEpoch) return;
      this.health = null;
      this.healthError = this.describeError(e);
    } finally {
      if (healthEpoch === this.healthEpoch) this.isCheckingHealth = false;
    }
  }

  async send() {
    if (this.isBusy) return;
    const text = this.draft.trim();
    if (text.length === 0) return;
    if (text.length > AGENT_MAX_MESSAGE_CHARS) {
      this.error = `El mensaje es demasiado largo (máximo ${AGENT_MAX_MESSAGE_CHARS} caracteres).`;
      return;
    }

    let documentText = this.serviceProvider.textEditorService.getPlainText();
    this.documentTruncated = documentText.length > AGENT_MAX_DOCUMENT_CHARS;
    if (this.documentTruncated) {
      documentText = documentText.slice(0, AGENT_MAX_DOCUMENT_CHARS);
    }

    const body = {
      messages: buildRequestMessages(this.messages, text),
      document: {text: documentText},
    };

    const epoch = this.epoch;
    const controller = new AbortController();
    this.abortController = controller;
    this.isBusy = true;
    this.error = null;
    this.pendingMessage = text;

    try {
      const res = await fetch(`${AGENT_API}/chat`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = (await this.parse(res)) as {
        reply: string;
        model?: string;
        toolCalls?: Array<{name: string}>;
      };
      if (epoch !== this.epoch) return;
      if (typeof data.reply !== 'string') {
        throw new Error('Respuesta inválida del servidor.');
      }
      this.messages.push({role: 'user', content: text});
      this.messages.push({
        role: 'assistant',
        content: data.reply,
        toolCalls: (data.toolCalls ?? []).map((t) => t.name),
      });
      this.messages = this.messages.slice(-AGENT_MAX_MESSAGES);
      this.draft = '';
      if (typeof data.model === 'string' && this.health) {
        this.health = {...this.health, model: data.model};
      }
    } catch (e) {
      if (epoch !== this.epoch) return;
      if (controller.signal.aborted) {
        this.error =
          'Dejaste de esperar. La solicitud puede seguir ejecutándose en el servidor (hasta unos 180 s). Tu mensaje sigue en el cuadro de texto.';
      } else {
        if (e instanceof AgentHttpError && e.status === 401) {
          this.health = {
            provider: 'claude-code',
            model: '',
            ...this.health,
            ready: false,
            loginRequired: true,
          };
          this.healthError = null;
        }
        this.error = this.describeError(e);
      }
    } finally {
      if (epoch === this.epoch) {
        this.isBusy = false;
        this.pendingMessage = null;
        this.abortController = null;
      }
    }
  }

  /** Asks the backend to launch the official Claude login; no credentials touch the browser. */
  async startLogin() {
    if (this.isStartingLogin) return;
    this.isStartingLogin = true;
    this.loginError = null;
    this.loginStarted = false;
    this.loginMessage = null;
    this.loginUrl = null;
    const epoch = this.epoch;
    const loginToken = ++this.loginToken;
    try {
      const res = await fetch(`${AGENT_API}/login`, {method: 'POST'});
      const data = (await this.parse(res)) as {
        started?: boolean;
        alreadyLoggedIn?: boolean;
        running?: boolean;
        url?: string;
        message?: string;
      };
      if (epoch !== this.epoch) return;
      if (data.started !== true) {
        throw new Error('El servidor no pudo iniciar el inicio de sesión.');
      }
      this.loginMessage = typeof data.message === 'string' ? data.message : null;
      this.loginUrl =
        typeof data.url === 'string' && /^https?:\/\//.test(data.url)
          ? data.url
          : null;
      if (data.alreadyLoggedIn === true) {
        this.loginStarted = false;
        this.checkHealth();
      } else {
        this.loginStarted = true;
      }
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.loginError = this.describeError(e);
    } finally {
      if (loginToken === this.loginToken) this.isStartingLogin = false;
    }
  }

  cancel() {
    this.abortController?.abort();
  }

  reset() {
    this.epoch++;
    this.healthEpoch++;
    this.loginToken++;
    this.isStartingLogin = false;
    this.loginStarted = false;
    this.loginMessage = null;
    this.loginUrl = null;
    this.loginError = null;
    this.abortController?.abort();
    this.abortController = null;
    this.messages = [];
    this.draft = '';
    this.pendingMessage = null;
    this.isBusy = false;
    this.error = null;
    this.documentTruncated = false;
    this.isCheckingHealth = false;
  }

  private async parse(res: Response) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch (e) {
      // Non-JSON body; handled below.
    }
    if (!res.ok) {
      const msg =
        data && typeof (data as {error?: unknown}).error === 'string'
          ? (data as {error: string}).error
          : `El servidor respondió con el error HTTP ${res.status}.`;
      throw new AgentHttpError(msg, res.status);
    }
    if (data == null) throw new Error('Respuesta inválida del servidor.');
    return data;
  }

  private describeError(e: unknown) {
    if (e instanceof TypeError) {
      return 'No se pudo conectar con el servidor de agentes.';
    }
    return e instanceof Error ? e.message : 'Error desconocido.';
  }
}

decorate(AgentService, {
  messages: observable.shallow,
  draft: observable,
  pendingMessage: observable,
  isBusy: observable,
  error: observable,
  health: observable,
  healthError: observable,
  isCheckingHealth: observable,
  documentTruncated: observable,
  isStartingLogin: observable,
  loginStarted: observable,
  loginMessage: observable,
  loginUrl: observable,
  canSend: computed,
  loginError: observable,
  setDraft: action,
  reset: action,
});

